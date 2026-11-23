// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { ChatStore, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import { chatHttp } from '../../src/chat/turns.http.js'
import { createChat } from '../../src/chat/turns.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { readBlocks } from '../../src/chat/blocks.js'
import { SimulatedProvider } from '../../src/models/simulated.js'
import type { Provider } from '../../src/models/provider.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { TestQueue } from '../support/test-queue.js'
import { publishOutbox } from '../../src/jobs/outbox.js'

const scopeId = 'fixture-personal'
const actions = ['conversation:create', 'turn:create', 'turn:read', 'turn:cancel', 'turn:run']
let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let actor: { userId: string; sessionId: string }
let ref: { userId: string; scopeId: string; turnId: string }
let time: number
const snapshot = () => createChat(store).getTurn(actor, scopeId, ref.turnId)
const cancel = () => chatHttp(createChat(store), { operation: 'cancelTurn', actor, scopeId, turnId: ref.turnId })
const worker = (provider: Provider, freshStore = store) => createGenerationWorker(freshStore, provider, { pollMs: 20 })
async function grant(allowed: string[]) {
  await store.db.send(new PutCommand({ TableName: store.tableName, Item: {
    pk: scopePartition(actor.userId, scopeId), sk: 'SCOPE', actions: new Set(allowed),
  } }))
}
beforeEach(async () => {
  time = Date.UTC(2026, 0, 1)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  actor = { userId: randomUUID(), sessionId: 'fixture-session' }
  for (const fields of [{ sk: 'ACCOUNT', mfaVerifiedAt: 1 }, { sk: 'SESSION#fixture-session', authTime: 2 }]) {
    await store.db.send(new PutCommand({ TableName: store.tableName, Item: {
      pk: JSON.stringify([actor.userId]), status: 'active', ...fields,
    } }))
  }
  await grant(actions)
  const chat = createChat(store)
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, 'fixture-key', { text: 'Entrada sintética' })
  ref = { userId: actor.userId, scopeId, turnId: t.turnId }
})
afterEach(() => local.client.destroy())

test('concurrent_claim_calls_model_once', async () => {
  const queue = new TestQueue()
  await publishOutbox(store, queue, ref)
  const job = queue.take()!
  const provider = new SimulatedProvider(['Uno', ' dos', ' tres'])
  const stream = vi.spyOn(provider, 'stream')
  await Promise.all([worker(provider).runTurn(job, 'first'), worker(provider).runTurn(job, 'second')])
  expect(stream).toHaveBeenCalledTimes(1)
  expect(await snapshot()).toMatchObject({ status: 'completed', lastSeq: 2, result: { text: 'Uno dos tres' } })
  expect(await readBlocks(store, ref, 1, 2, 10)).toEqual([{ type: 'text', turnId: ref.turnId, seq: 2, text: ' dos tres' }])
})

test.each([['timeout_before_output_failed', false], ['timeout_after_output_incomplete', true]] as const)('%s', async (_name, partial) => {
  const provider: Provider = { async *stream({ signal }) {
    if (partial) yield { type: 'text', text: 'Primero' }
    await delay(60_000, undefined, { signal })
  } }
  await createGenerationWorker(store, provider, { timeoutMs: 200, pollMs: 25 }).runTurn(ref, 'timeout')
  expect(await snapshot()).toEqual(expect.objectContaining({
    status: partial ? 'incomplete' : 'failed', lastSeq: partial ? 1 : 0,
    error: { code: 'GENERATION_TIMEOUT', message: expect.any(String), requestId: expect.any(String) },
    ...(partial && { result: { text: 'Primero' } }),
  }))
})

test('ambiguous_send_not_retried', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const provider: Provider = { stream: vi.fn(async function* () {
    started.resolve()
    await release.promise
    yield { type: 'text' as const, text: 'Respuesta tardía' }
  }) }
  const first = worker(provider).runTurn(ref, 'first')
  await started.promise
  time += 120_000
  try {
    const restarted = new ChatStore(local.client, local.tableName, () => new Date(time))
    await worker(provider, restarted).runTurn(ref, 'redelivery')
    await worker(provider, restarted).runTurn(ref, 'later')
    expect(await snapshot()).toMatchObject({ status: 'failed', lastSeq: 0, error: { code: 'SEND_UNCERTAIN' } })
    expect(provider.stream).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve()
    await first
  }
  expect(await snapshot()).not.toHaveProperty('result')
})

test('cancel_blocks_new_calls', async () => {
  const provider = new SimulatedProvider()
  const stream = vi.spyOn(provider, 'stream')
  expect((await chatHttp(createChat(store), { operation: 'cancelTurn', scopeId, turnId: ref.turnId })).status).toBe(401)
  await grant(actions.filter(action => action !== 'turn:cancel'))
  expect((await cancel()).status).toBe(403)
  await grant(actions)
  expect(await cancel()).toMatchObject({ status: 200, body: { status: 'cancelled', lastSeq: 0 } })
  await worker(provider).runTurn(ref, 'late')
  expect(await cancel()).toMatchObject({ status: 200, body: { status: 'cancelled' } })
  expect(stream).not.toHaveBeenCalled()
})

test('cancellation_interrupts_waiting_provider_and_preserves_first_block', async () => {
  let aborted = false
  const waiting = Promise.withResolvers<void>()
  const provider: Provider = { async *stream({ signal }) {
    yield { type: 'text', text: 'Primero' }
    waiting.resolve()
    try { await delay(60_000, undefined, { signal }) } finally { aborted = signal.aborted }
  } }
  const running = worker(provider).runTurn(ref, 'first')
  await waiting.promise
  expect((await cancel()).body).toMatchObject({ status: 'cancelled', lastSeq: 1 })
  await running
  expect(aborted).toBe(true)
  expect(await snapshot()).toMatchObject({ status: 'cancelled', lastSeq: 1, result: { text: 'Primero' } })
})

test('revocation_fences_output_and_new_calls', async () => {
  const provider: Provider = { async *stream() {
    yield { type: 'text', text: 'Antes' }
    await grant(actions.filter(action => action !== 'turn:run'))
    yield { type: 'text', text: 'Después' }
  } }
  await worker(provider).runTurn(ref, 'revoked')
  expect(await snapshot()).toMatchObject({ status: 'blocked', lastSeq: 0, error: { code: 'PERMISSION_REVOKED' } })
  expect(await snapshot()).not.toHaveProperty('result')
  const key = turnKey(ref)
  expect((await store.read(key.pk, key.sk))?.attemptId).toBe('revoked')
})

test('grant_for_create_does_not_grant_run', async () => {
  await grant(actions.filter(action => action !== 'turn:run'))
  const provider = new SimulatedProvider()
  const stream = vi.spyOn(provider, 'stream')
  await worker(provider).runTurn(ref, 'revoked')
  expect(stream).not.toHaveBeenCalled()
  expect(await snapshot()).toMatchObject({ status: 'blocked', lastSeq: 0 })
})


test('cancel_after_send_marker_and_before_provider_prevents_dispatch', async () => {
  const original = store.transactGuarded.bind(store)
  let marked = false
  vi.spyOn(store, 'transactGuarded').mockImplementation(async writes => {
    await original(writes)
    if (!marked && writes.some(w => w.Update?.UpdateExpression?.startsWith('SET sendState'))) {
      marked = true
      expect((await cancel()).status).toBe(200)
    }
  })
  const provider = new SimulatedProvider()
  const stream = vi.spyOn(provider, 'stream')
  await worker(provider).runTurn(ref, 'first')
  expect(marked).toBe(true)
  expect(stream).not.toHaveBeenCalled()
  expect(await snapshot()).toMatchObject({ status: 'cancelled', lastSeq: 0 })
})

test('expired_unsent_lease_can_be_reclaimed_and_stale_owner_is_fenced', async () => {
  const original = store.transactGuarded.bind(store)
  const claimed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let pause = true
  vi.spyOn(store, 'transactGuarded').mockImplementation(async writes => {
    await original(writes)
    if (pause && writes.some(w => w.Update?.UpdateExpression?.includes('leaseUntil = :until'))) {
      pause = false
      claimed.resolve()
      await release.promise
    }
  })
  const provider = new SimulatedProvider()
  const stream = vi.spyOn(provider, 'stream')
  const first = worker(provider).runTurn(ref, 'same-delivery-id')
  await claimed.promise
  try {
    expect(await worker(provider).runTurn(ref, 'busy')).toBe('retry')
    time += 120_000
    expect(await worker(provider).runTurn(ref, 'same-delivery-id')).toBe('done')
  } finally {
    release.resolve()
    await first
  }
  expect(stream).toHaveBeenCalledTimes(1)
  expect(await snapshot()).toMatchObject({ status: 'completed', lastSeq: 2 })
})

test('adapter_uncertainty_preserves_partial_text_and_never_leaks_error', async () => {
  const { UncertainSend } = await import('../../src/models/provider.js')
  const provider: Provider = { stream: vi.fn(async function* () {
    yield { type: 'text' as const, text: 'Inicio' }
    throw new UncertainSend('internal fixture transport details')
  }) }
  await worker(provider).runTurn(ref, 'one')
  await worker(provider).runTurn(ref, 'two')
  const recovered = await snapshot()
  expect(recovered).toMatchObject({ status: 'incomplete', lastSeq: 1, result: { text: 'Inicio' }, error: { code: 'SEND_UNCERTAIN' } })
  expect(JSON.stringify(recovered)).not.toContain('internal fixture')
  expect(provider.stream).toHaveBeenCalledTimes(1)
})

test('cancel_cannot_disclose_a_snapshot_without_turn_read', async () => {
  await worker(new SimulatedProvider()).runTurn(ref, 'complete')
  await grant(actions.filter(action => action !== 'turn:read'))
  expect(await cancel()).toMatchObject({ status: 403, body: { code: 'PERMISSION_REVOKED' } })
})

test('lease_expiry_during_write_guards_fences_the_block', async () => {
  const original = store.writeGuards.bind(store)
  const provider: Provider = { async *stream() {
    vi.spyOn(store, 'writeGuards').mockImplementationOnce(async (...args) => {
      const guards = await original(...args)
      time += 120_000
      return guards
    })
    yield { type: 'text', text: 'Tarde' }
  } }
  expect(await worker(provider).runTurn(ref, 'expired')).toBe('retry')
  expect(await snapshot()).toMatchObject({ status: 'running', lastSeq: 0 })
  await worker(provider).runTurn(ref, 'redrive')
  expect(await snapshot()).toMatchObject({ status: 'failed', error: { code: 'SEND_UNCERTAIN' } })
})

test.each([false, true])('deadline_during_slow_policy_read_partial_%s', async partial => {
  let abortedDuringRead = false
  const provider: Provider = { async *stream({ signal }) {
    if (partial) yield { type: 'text', text: 'Primero' }
    const original = store.getScopeActions.bind(store)
    vi.spyOn(store, 'getScopeActions').mockImplementationOnce(async (...args) => {
      await delay(650)
      abortedDuringRead = signal.aborted
      return original(...args)
    })
    // A provider may ignore cooperative abort and return a late chunk or EOF.
    await delay(450)
    if (partial) yield { type: 'text', text: 'Tardío' }
  } }
  await createGenerationWorker(store, provider, { timeoutMs: 250, pollMs: 40 }).runTurn(ref, 'delayed-read')
  expect(await snapshot()).toMatchObject({
    status: partial ? 'incomplete' : 'failed', lastSeq: partial ? 1 : 0,
    ...(partial && { result: { text: 'Primero' } }), error: { code: 'GENERATION_TIMEOUT' },
  })
  expect(abortedDuringRead).toBe(true)
})
