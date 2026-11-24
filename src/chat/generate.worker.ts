// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { TIMING } from '../config/timing.js'
import { ModelPolicyDenied, UncertainSend, type Provider, type ProviderEvent } from '../models/provider.js'
import { ChatStore, turnKey } from './turns.store.js'
import { ChatError, type TurnReference } from './turns.types.js'
import { active, blockTurn, changeTurn, GenerationAttempt, publicFault, readRow, type FaultCode } from './generation.store.js'

interface Options {
  readonly timeoutMs?: number
  readonly leaseMs?: number
  readonly pollMs?: number
}
class LeaseLost extends Error {}
const fenced = (won: boolean) => { if (!won) throw new LeaseLost() }
const isDenied = (err: unknown) => err instanceof ChatError && err.status === 403

type Next = { kind: 'event'; event: IteratorResult<ProviderEvent> } | { kind: 'error'; code: FaultCode } | { kind: 'denied'; error: ModelPolicyDenied }
function next(iterator: AsyncIterator<ProviderEvent>): Promise<Next> {
  return Promise.resolve().then(() => iterator.next()).then(
    event => ({ kind: 'event', event }),
    error => error instanceof ModelPolicyDenied ? { kind: 'denied', error } :
      { kind: 'error', code: error instanceof UncertainSend ? 'SEND_UNCERTAIN' : 'GENERATION_FAILED' },
  )
}

async function untilTick(pending: Promise<Next>, ms: number): Promise<Next | 'tick'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<'tick'>(resolve => { timer = setTimeout(() => resolve('tick'), ms) })])
  } finally { clearTimeout(timer) }
}

async function checkLive(attempt: GenerationAttempt) {
  await attempt.authorize()
  const row = await readRow(attempt.store, attempt.ref)
  fenced(row?.status === 'running' && row.leaseId === attempt.leaseId && row.leaseUntil! > attempt.store.now().getTime())
}

async function generate(attempt: GenerationAttempt, provider: Provider, timeoutMs: number, pollMs: number) {
  const { store, ref } = attempt
  const input = await store.read(turnKey(ref).pk, attempt.row.messageSk)
  if (typeof input?.text !== 'string' || input.turnId !== ref.turnId) throw new Error('Missing turn input')
  await attempt.authorize()
  // Persist intent before crossing the provider boundary. A process death
  // between these operations must conservatively leave an uncertain send.
  fenced(await attempt.update('SET sendState = :uncertain', { ':uncertain': 'uncertain' }, ' AND attribute_not_exists(sendState)'))
  await checkLive(attempt)
  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  const expired = () => controller.signal.aborted || performance.now() >= deadline
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let iterator: AsyncIterator<ProviderEvent> | undefined
  let fault: FaultCode | undefined
  let seq = 0
  let text = ''
  let buffer = ''
  let bytes = 0
  let flushAt = Infinity
  const flush = async () => {
    if (!buffer) return
    const combined = text + buffer
    fenced(await attempt.append(seq + 1, buffer, combined))
    seq++
    text = combined
    buffer = ''
    flushAt = Infinity
  }
  try {
    try {
      iterator = provider.stream({ ref, leaseId: attempt.leaseId, sessionId: attempt.row.sessionId,
        messageSk: attempt.row.messageSk, attemptId: attempt.attemptId, text: input.text, signal: controller.signal })[Symbol.asyncIterator]()
    } catch (err) {
      if (err instanceof ModelPolicyDenied) throw err
      fault = err instanceof UncertainSend ? 'SEND_UNCERTAIN' : 'GENERATION_FAILED'
    }
    if (iterator) {
      let pollAt = performance.now() + pollMs
      let pending: Promise<Next> | undefined
      while (!expired()) {
        const now = performance.now()
        if (now >= pollAt) {
          await checkLive(attempt)
          pollAt = performance.now() + pollMs
          continue
        }
        if (now >= flushAt) {
          await flush()
          continue
        }
        pending ??= next(iterator)
        const result = await untilTick(pending, Math.min(deadline, pollAt, flushAt) - performance.now())
        if (result === 'tick') continue
        if (expired()) break
        pending = undefined
        if (result.kind === 'denied') throw result.error
        if (result.kind === 'error') { fault = result.code; break }
        if (result.event.done) break
        const chunk = result.event.value.text
        if (chunk) {
          // Keep room for keys and metadata on the snapshot item.
          bytes += Buffer.byteLength(chunk)
          if (bytes > 384 * 1024) { fault = 'GENERATION_FAILED'; break }
          if (!buffer) flushAt = performance.now() + 500
          buffer += chunk
          if (seq === 0 || Buffer.byteLength(buffer) >= 8192) await flush()
        }
      }
    }
    if (expired()) fault = 'GENERATION_TIMEOUT'
    clearTimeout(timeout)
    controller.abort()
    await flush()
    if (fault) {
      fenced(await attempt.update('SET #status = :status, #error = :error',
        { ':status': seq ? 'incomplete' : 'failed', ':error': publicFault(fault) }))
    } else {
      fenced(await attempt.update('SET #status = :status, sendState = :confirmed',
        { ':status': 'completed', ':confirmed': 'confirmed' }))
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
    // A remote iterator can ignore abort. Its unresolved cleanup cannot hold
    // the job open or publish any later events.
    if (iterator?.return) void iterator.return().catch(() => {})
  }
}

export function createGenerationWorker(store: ChatStore, provider: Provider, options: Options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMING.providerTimeoutSeconds * 1000
  const leaseMs = options.leaseMs ?? (options.timeoutMs === undefined ? TIMING.leaseSeconds * 1000 : timeoutMs + 30_000)
  const pollMs = options.pollMs ?? 500
  if (![timeoutMs, leaseMs, pollMs].every(n => Number.isSafeInteger(n) && n > 0) || leaseMs <= timeoutMs) {
    throw new RangeError('Generation requires positive durations and a lease longer than the provider timeout')
  }

  return {
    // Queue consumers must redeliver 'retry' (busy or expired lease) and
    // infrastructure failures. Only a durable terminal state can be acknowledged.
    async runTurn(ref: TurnReference, attemptId: string): Promise<'done' | 'retry'> {
      const row = await readRow(store, ref)
      if (!row || !active(row.status)) return 'done'
      if (row.status === 'running' && row.leaseUntil! > store.now().getTime()) return 'retry'
      const attempt = new GenerationAttempt(store, ref, attemptId, row)
      let owned = row
      try {
        await attempt.authorize()
        if (row.sendState === 'uncertain') {
          fenced(await changeTurn(store, ref, {
            ConditionExpression: '#status = :running AND leaseId = :lease AND leaseUntil <= :now AND sendState = :uncertain AND lastSeq = :seq',
            UpdateExpression: 'SET #status = :status, #error = :error',
            ExpressionAttributeValues: { ':running': 'running', ':lease': row.leaseId, ':now': store.now().getTime(),
              ':uncertain': 'uncertain', ':seq': row.lastSeq, ':status': row.lastSeq ? 'incomplete' : 'failed',
              ':error': publicFault('SEND_UNCERTAIN') },
          }, attempt.guard))
        } else {
          fenced(await attempt.claim(leaseMs))
          owned = { ...row, status: 'running', leaseId: attempt.leaseId }
          await generate(attempt, provider, timeoutMs, pollMs)
        }
        return 'done'
      } catch (error) {
        if (error instanceof ModelPolicyDenied) await blockTurn(store, ref, owned, 'MODEL_POLICY_DENIED')
        else if (isDenied(error)) await blockTurn(store, ref, owned)
        else if (!(error instanceof LeaseLost)) throw error
        const current = await readRow(store, ref)
        return current && active(current.status) ? 'retry' : 'done'
      }
    },
  }
}

