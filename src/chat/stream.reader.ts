// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { setTimeout as sleep } from 'node:timers/promises'
import { TransactGetCommand } from '@aws-sdk/lib-dynamodb'
import { permitsAuthentication, type Actor } from '../identity/actor.js'
import { readBlocks } from './blocks.js'
import { scopePartition, type ChatStore } from './turns.store.js'
import { ChatError, forbidden, notFound, type TurnReference, type TurnStatus } from './turns.types.js'

type Snapshot = { status: TurnStatus; lastSeq: number }
export interface StreamSource {
  snapshot(actor: Actor, ref: TurnReference, signal: AbortSignal): Promise<Snapshot>
  blocks(ref: TurnReference, after: number, lastSeq: number, limit: number, signal: AbortSignal): ReturnType<typeof readBlocks>
}

export function dynamoStreamSource(store: ChatStore): StreamSource {
  return {
    async snapshot(actor, ref, signal) {
      const owner = JSON.stringify([actor.userId])
      const pk = scopePartition(actor.userId, ref.scopeId)
      const get = (partition: string, sk: string, attributes: string[]) => ({
        Get: { TableName: store.tableName, Key: { pk: partition, sk },
          ProjectionExpression: attributes.map(name => '#' + name).join(', '),
          ExpressionAttributeNames: Object.fromEntries(attributes.map(name => ['#' + name, name])) },
      })
      // One serializable read binds the visible high-water mark to the current grant and session.
      const result = await store.transactRead(new TransactGetCommand({ TransactItems: [
        get(owner, 'ACCOUNT', ['status', 'mfaVerifiedAt']), get(owner, 'SESSION#' + actor.sessionId, ['status', 'authTime']),
        get(pk, 'SCOPE', ['actions']), get(pk, 'TURN#' + ref.turnId, ['status', 'lastSeq']),
      ] }), signal)
      const [account, session, grant, turn] = (result.Responses ?? []).map(row => row.Item)
      if (account?.status !== 'active' || session?.status !== 'active' ||
          !permitsAuthentication({ status: 'active', mfaVerifiedAt: account.mfaVerifiedAt }, session.authTime) ||
          !(grant?.actions instanceof Set && grant.actions.has('turn:stream'))) throw forbidden()
      if (!turn) throw notFound()
      if (!['queued','running','completed','incomplete','failed','cancelled','blocked'].includes(turn.status) ||
          !Number.isSafeInteger(turn.lastSeq) || turn.lastSeq < 0 ||
          (['blocked','failed'].includes(turn.status) && turn.lastSeq !== 0) ||
          (turn.status === 'incomplete' && turn.lastSeq === 0)) throw new Error('Invalid stream snapshot')
      return { status: turn.status, lastSeq: turn.lastSeq }
    },
    blocks: (ref, after, lastSeq, limit, signal) => readBlocks(store, ref, after, lastSeq, limit, signal),
  }
}

const defaults = { batchSize: 16, durationMs: 24_000, maxConnections: 4, idleMs: 200, maxIdleMs: 2_000, heartbeatMs: 8_000 }
const frame = <T extends { type: string }>(data: T) => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n'

export function createStreamReader(source: StreamSource, settings: Partial<typeof defaults> = {}) {
  const options = { ...defaults, ...settings }
  if (Object.values(options).some(v => !Number.isSafeInteger(v) || v < 1) || options.batchSize > 100 ||
      options.idleMs > options.maxIdleMs || options.durationMs > 2_147_483_647) throw new RangeError('Invalid stream limits')
  let connections = 0

  async function* readStream(actor: Actor, scopeId: string, turnId: string, after: number, disconnect?: AbortSignal): AsyncGenerator<string> {
    if (!Number.isSafeInteger(after) || after < 0 || [scopeId, turnId].some(id => !id || Buffer.byteLength(id) > 256)) {
      throw new ChatError(400, 'INVALID_REQUEST', 'La solicitud es inválida.')
    }
    if (connections >= options.maxConnections) throw new ChatError(429, 'RATE_LIMITED', 'Hay demasiadas conexiones activas.')
    ++connections
    const deadline = Date.now() + options.durationMs
    const expiry = AbortSignal.timeout(options.durationMs)
    const signal = disconnect ? AbortSignal.any([expiry, disconnect]) : expiry
    const expired = () => signal.aborted || Date.now() >= deadline
    const ref = { userId: actor.userId, scopeId, turnId }
    let opened = false
    let previousStatus: TurnStatus | undefined
    let idle = options.idleMs
    let heartbeat = Date.now() + options.heartbeatMs
    try {
      while (!expired()) {
        let snapshot = await source.snapshot(actor, ref, signal)
        if (expired()) return
        if (after < snapshot.lastSeq) {
          const page = await source.blocks(ref, after, snapshot.lastSeq, options.batchSize, signal)
          if (expired()) return
          snapshot = await source.snapshot(actor, ref, signal)
          if (expired()) return
          if (after < snapshot.lastSeq) {
            if (!page.length || page.length > options.batchSize || page.some((block, i) =>
              block.turnId !== turnId || block.seq !== after + i + 1 || block.seq > snapshot.lastSeq ||
              typeof block.text !== 'string' || !block.text.length)) throw new Error('Non-contiguous stream page')
            after = page[page.length - 1].seq
            idle = options.idleMs
            heartbeat = Date.now() + options.heartbeatMs
            opened = true
            yield page.map(frame).join('')
            continue
          }
        }
        const { status, lastSeq } = snapshot
        if (status !== 'queued' && status !== 'running') {
          yield frame({ type: 'status', turnId, status, lastSeq })
          return
        }
        if (status !== previousStatus || Date.now() >= heartbeat) {
          const batch = status !== previousStatus ? frame({ type: 'status', turnId, status }) : ': keep-alive\n\n'
          previousStatus = status
          heartbeat = Date.now() + options.heartbeatMs
          opened = true
          yield batch
        }
        await sleep(Math.min(idle, Math.max(1, heartbeat - Date.now())), undefined, { signal })
        idle = Math.min(options.maxIdleMs, idle * 2)
      }
    } catch (error) {
      if (!expired() && !(opened && error instanceof ChatError && [403, 404].includes(error.status))) throw error
    } finally {
      --connections
    }
  }
  return { readStream }
}
