// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import { setTimeout as delay } from 'node:timers/promises'
import type { Actor } from '../identity/actor.js'
import { createPolicy, type Action } from '../identity/policy.js'
import { blockKey } from './blocks.js'
import { ChatStore, turnKey } from './turns.store.js'
import { forbidden, type TurnReference, type TurnStatus } from './turns.types.js'

type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>
type Update = NonNullable<Writes[number]['Update']>
type Change = Pick<Update, 'UpdateExpression' | 'ConditionExpression' | 'ExpressionAttributeValues'>
type Guard = { actor: Actor; action: Action }

export interface TurnRow {
  readonly sessionId: string
  readonly messageSk: string
  readonly status: TurnStatus
  readonly leaseId?: string
  readonly leaseUntil?: number
  readonly attemptId?: string
  readonly sendState?: 'uncertain' | 'confirmed'
  readonly lastSeq: number
  readonly result?: { text: string }
}
export const active = (status: TurnStatus) => status === 'queued' || status === 'running'
export const readRow = async (store: ChatStore, ref: TurnReference) => {
  const { pk, sk } = turnKey(ref)
  return await store.read(pk, sk) as TurnRow | undefined
}

// Policy condition failures are translated by ChatStore. A failed turn
// condition means another worker or cancellation won; unrelated errors propagate.
export async function changeTurn(store: ChatStore, ref: TurnReference, mutation: Change | ((now: number) => Change), guard?: Guard, extra: Writes = []) {
  for (let retry = 0; ; retry++) {
    const guards = guard ? await store.writeGuards(guard.actor, ref.scopeId, guard.action) : []
    const change = typeof mutation === 'function' ? mutation(store.now().getTime()) : mutation
    const aliases: Record<string, string> = { '#status': 'status' }
    for (const name of ['error', 'result']) {
      if (change.UpdateExpression?.includes('#' + name)) aliases['#' + name] = name
    }
    const update = { Update: { TableName: store.tableName, Key: turnKey(ref), ExpressionAttributeNames: aliases, ...change } }
    try {
      if (guard) await store.transactGuarded([...guards, update, ...extra])
      else await store.db.send(new TransactWriteCommand({ TransactItems: [update, ...extra] }))
      return true
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error
      const reasons = error.CancellationReasons ?? []
      if (reasons[guards.length]?.Code === 'ConditionalCheckFailed') return false
      if (retry >= 6 || !reasons.some(r => r.Code === 'TransactionConflict')) throw error
      await delay(5 * 2 ** retry)
    }
  }
}

const messages = {
  SEND_UNCERTAIN: 'No se pudo confirmar el envío al proveedor.',
  GENERATION_FAILED: 'No se pudo completar la generación.',
  GENERATION_TIMEOUT: 'Se agotó el tiempo de generación.',
  PERMISSION_REVOKED: 'El acceso ya no está permitido.',
}
export type FaultCode = keyof typeof messages
export const publicFault = (code: FaultCode) => ({ code, message: messages[code], requestId: randomUUID() })

// Only suppresses the visible result. This write must work after revocation.
// Fence against the observed generation; cancellation or a newer lease wins.
export async function blockTurn(store: ChatStore, ref: TurnReference, row: TurnRow) {
  const lease = row.status === 'running'
  return changeTurn(store, ref, {
    ConditionExpression: '#status = :previous' + (lease ? ' AND leaseId = :lease' : ''),
    UpdateExpression: 'SET #status = :blocked, lastSeq = :zero, #error = :fault REMOVE #result',
    ExpressionAttributeValues: { ':previous': row.status, ':blocked': 'blocked', ':zero': 0,
      ':fault': publicFault('PERMISSION_REVOKED'), ...(lease && { ':lease': row.leaseId }) },
  })
}

export class GenerationAttempt {
  readonly actor: Actor
  readonly leaseId = randomUUID()
  readonly guard: Guard
  constructor(readonly store: ChatStore, readonly ref: TurnReference, readonly attemptId: string, readonly row: TurnRow) {
    this.actor = { userId: ref.userId, sessionId: row.sessionId }
    this.guard = { actor: this.actor, action: 'turn:run' }
  }

  async authorize() {
    const permit = await createPolicy(this.store, this.store).authorize(this.actor, this.ref.scopeId, 'turn:run', this.ref.turnId)
    if (!permit.allowed) throw forbidden()
  }

  // An expired lease is reclaimable only before the send-intent marker.
  claim(leaseMs: number) {
    return changeTurn(this.store, this.ref, now => ({
      ConditionExpression: '(#status = :queued OR (#status = :running AND leaseUntil <= :now)) AND attribute_not_exists(sendState)',
      UpdateExpression: 'SET #status = :running, attemptId = :attempt, leaseId = :lease, leaseUntil = :until',
      ExpressionAttributeValues: { ':queued': 'queued', ':running': 'running', ':now': now, ':until': now + leaseMs,
        ':attempt': this.attemptId, ':lease': this.leaseId },
    }), this.guard)
  }

  update(expression: string, values: Record<string, unknown>, condition = '', extra: Writes = []) {
    return changeTurn(this.store, this.ref, now => ({
      ConditionExpression: '#status = :running AND leaseId = :lease AND leaseUntil > :now' + condition,
      UpdateExpression: expression,
      ExpressionAttributeValues: { ':running': 'running', ':lease': this.leaseId, ':now': now, ...values },
    }), this.guard, extra)
  }

  append(seq: number, text: string, fullText: string) {
    return this.update('SET lastSeq = :next, #result = :result', { ':next': seq, ':previous': seq - 1, ':result': { text: fullText } },
      ' AND lastSeq = :previous', [{ Put: { TableName: this.store.tableName, ConditionExpression: 'attribute_not_exists(pk)',
        Item: { pk: turnKey(this.ref).pk, sk: blockKey(this.ref.turnId, seq), seq, text } } }])
  }
}

