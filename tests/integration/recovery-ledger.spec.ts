// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Recovery paths measured against the AI ledger: republication, queue duplicates, redrive and expired
// leases must never create a second reservation for a turn or a second provider call.

import { randomUUID } from 'node:crypto'
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createWorkerHandler } from '../../src/chat/generate.lambda.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import { TIMING } from '../../src/config/timing.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { ModelBudget, type Tariff } from '../../src/models/budget.js'
import { createTurnDispatcher, type ModelTransport } from '../../src/models/dispatch.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { FifoTurnQueue, deliver, DEDUPLICATION_WINDOW_MS } from '../support/fifo-queue.js'

const second = 1000
const usd = 1_000_000
const provider = 'fixture-a'
const scopeId = 'fixture-scope'
const price: Tariff = {
  inputPerMillion: 300_000, outputPerMillion: 1_100_000, toolCall: 23,
  verifiedAt: Date.UTC(2025, 0), expiresAt: Date.UTC(2040, 0),
}
const usage = { inputTokens: 3, outputTokens: 2, reasoningTokens: 4, toolTokens: 5, toolCalls: 2 }
const limits = { outputTokens: 100, reasoningTokens: 50, toolTokens: 30, toolCalls: 2 }
const goodGrant = { enabled: true, origins: ['direct'], categories: ['chat'], integrations: ['manual'] }
const config = () => ({ provider, model: 'fixture-model', tariff: price, limits })
const transient = () => Object.assign(new Error('fixture throttling'), { name: 'ProvisionedThroughputExceededException' })

let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let budget: ModelBudget
let queue: FifoTurnQueue
let actor: { userId: string; sessionId: string }
let time: number
// Counters are global per UTC month and the table is shared with other spec files running in parallel:
// each test gets its own month, in a year range no other spec uses (tariffs stay valid until 2040).
let monthIndex = 0
let month: string

const write = (pk: string, sk: string, fields: Record<string, unknown>) =>
  store.db.send(new PutCommand({ TableName: store.tableName, Item: { pk, sk, ...fields } }))

beforeEach(async () => {
  time = Date.UTC(2033, monthIndex++, 1)
  month = new Date(time).toISOString().slice(0, 7)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  budget = new ModelBudget(store, { [provider]: 6 * usd })
  queue = new FifoTurnQueue(undefined, undefined, () => time)
  actor = { userId: randomUUID(), sessionId: 'fixture-session' }
  await write(JSON.stringify([actor.userId]), 'ACCOUNT', { status: 'active', mfaVerifiedAt: 1 })
  await write(JSON.stringify([actor.userId]), 'SESSION#fixture-session', { status: 'active', authTime: 2 })
  await write(scopePartition(actor.userId, scopeId), 'SCOPE', {
    actions: new Set(['turn:create', 'conversation:create', 'turn:run', 'turn:read', 'turn:stream']) })
  await write(scopePartition(actor.userId, scopeId), 'MODEL#' + provider, goodGrant)
})
afterEach(() => { vi.restoreAllMocks(); local.client.destroy() })

async function accept() {
  const chat = createChat(store)
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, randomUUID(), { text: 'Entrada sintética' })
  return { userId: actor.userId, scopeId, turnId: t.turnId }
}
type Ref = Awaited<ReturnType<typeof accept>>
const turn = (ref: Ref) => store.read(turnKey(ref).pk, turnKey(ref).sk)

/** A transport that crosses the send boundary and then hangs, like an invocation killed mid-call. */
function hangingTransport() {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const stream = vi.fn<ModelTransport['stream']>(async function* () {
    started.resolve()
    await release.promise
    yield { type: 'text', text: 'Respuesta tardía' }
    yield { type: 'usage', usage }
  })
  return { transport: { inputTokenBound: (t: string) => Buffer.byteLength(t, 'utf8') + 12, stream } as ModelTransport,
    started: started.promise, release: () => release.resolve() }
}
function normalTransport() {
  const stream = vi.fn<ModelTransport['stream']>(async function* () {
    yield { type: 'text', text: 'Respuesta' }
    yield { type: 'usage', usage }
  })
  return { inputTokenBound: (t: string) => Buffer.byteLength(t, 'utf8') + 12, stream } as ModelTransport
}
function handlerFor(transport: ModelTransport) {
  const worker = createGenerationWorker(store, createTurnDispatcher(store, budget, config, transport))
  return createWorkerHandler({ log: () => {}, newAttemptId: randomUUID, run: (ref, id) => worker.runTurn(ref, id) })
}

async function ledgerRows(ref: Ref) {
  const { Items } = await store.db.send(new QueryCommand({ TableName: store.tableName, ConsistentRead: true,
    KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'MODEL-LEDGER#' + month } }))
  return (Items ?? []).filter(row => row.turnId === ref.turnId)
}
const allocated = async () => (await store.read('MODEL-BUDGET#' + month, 'TOTAL'))?.allocated as number | undefined

/** One ledger row for the turn (and one per attempt), one provider call, and the reservation held in `state`. */
async function expectSingleReservation(ref: Ref, transport: ModelTransport, state: 'reserved' | 'settled') {
  const rows = await ledgerRows(ref)
  expect(rows).toHaveLength(1)
  expect(new Set(rows.map(row => row.attemptId)).size).toBe(1)
  expect(rows[0]).toMatchObject({ userId: ref.userId, scopeId: ref.scopeId, state })
  expect(await budget.getAttempt(rows[0]!.attemptId)).toMatchObject({ state, turnId: ref.turnId })
  expect(transport.stream).toHaveBeenCalledTimes(1)
  return rows[0]!
}

describe('no_duplicate_reservation_during_recovery', () => {
  test('republication after a crash between the send and the outbox mark', async () => {
    const ref = await accept()
    const transport = normalTransport()
    const handler = handlerFor(transport)
    vi.spyOn(store, 'markPublished').mockRejectedValueOnce(transient())
    await expect(publishOutbox(store, queue, ref)).rejects.toThrow('fixture throttling')
    // The relay retries inside the deduplication window: SQS drops the second send.
    await publishOutbox(store, queue, ref)
    expect(queue.depth).toEqual({ queued: 1, deadLetters: 0 })
    expect(await deliver(queue, time, handler)).toBe('deleted')
    expect(await turn(ref)).toMatchObject({ status: 'completed', claims: 1 })
    await expectSingleReservation(ref, transport, 'settled')
  })

  test('duplicate outside the five minute deduplication window', async () => {
    const ref = await accept()
    const transport = normalTransport()
    const handler = handlerFor(transport)
    vi.spyOn(store, 'markPublished').mockRejectedValueOnce(transient())
    await expect(publishOutbox(store, queue, ref)).rejects.toThrow()
    expect(await deliver(queue, time, handler)).toBe('deleted')
    time += DEDUPLICATION_WINDOW_MS + second
    await publishOutbox(store, queue, ref)
    // The window is closed: the second message is real, reaches the worker and finds a terminal turn.
    expect(queue.depth).toEqual({ queued: 1, deadLetters: 0 })
    expect(await deliver(queue, time, handler)).toBe('deleted')
    expect(await turn(ref)).toMatchObject({ status: 'completed', claims: 1 })
    await expectSingleReservation(ref, transport, 'settled')
  })

  test('FIFO redrive from the DLQ, which replaces the deduplication ID', async () => {
    const ref = await accept()
    const { transport, started, release } = hangingTransport()
    const handler = handlerFor(transport)
    await publishOutbox(store, queue, ref)
    const killed = handler({ Records: [queue.receive(time)!] })
    await started
    try {
      const read = vi.spyOn(store, 'read').mockRejectedValue(transient())
      for (let receive = 2; receive <= TIMING.turnMaxReceives; receive++) {
        time += TIMING.turnVisibilitySeconds * second
        expect(await deliver(queue, time, handler)).toBe('failed')
      }
      time += TIMING.turnVisibilitySeconds * second
      expect(await deliver(queue, time, handler)).toBe('empty')
      expect(queue.depth).toEqual({ queued: 0, deadLetters: 1 })
      read.mockRestore()
      queue.redrive()
      expect(await deliver(queue, time, handler)).toBe('deleted')
      expect(await turn(ref)).toMatchObject({ status: 'failed', error: { code: 'SEND_UNCERTAIN' } })
      const row = await expectSingleReservation(ref, transport, 'reserved')
      expect(await allocated()).toBe(row.maxCost)
    } finally {
      release()
      await killed
    }
  })

  test('expired lease while the reservation is still reserved', async () => {
    const ref = await accept()
    const { transport, started, release } = hangingTransport()
    const handler = handlerFor(transport)
    await publishOutbox(store, queue, ref)
    const received = time
    const first = queue.receive(time)!
    const killed = handler({ Records: [first] })
    await started
    try {
      // A duplicate while the lease is valid is retried without a new reservation.
      expect(await handler({ Records: [first] })).toEqual({ batchItemFailures: [{ itemIdentifier: first.messageId }] })
      time = received + TIMING.turnVisibilitySeconds * second
      expect(await deliver(queue, time, handler)).toBe('deleted')
      expect(await turn(ref)).toMatchObject({ status: 'failed', error: { code: 'SEND_UNCERTAIN' } })
      const row = await expectSingleReservation(ref, transport, 'reserved')
      // The uncertain reservation is conserved, never released by recovery.
      expect(await allocated()).toBe(row.maxCost)
      expect(row.maxCost).toBeGreaterThan(0)
    } finally {
      release()
      await killed
    }
  })
})

describe('one reservation per turn', () => {
  const audit = (turnId: string) => ({ model: 'fixture-model', operation: 'chat' as const, tariff: price, turnId })

  test('a second reservation for the same turn is rejected even with a new attempt ID', async () => {
    const turnId = randomUUID()
    const first = await budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, usd, audit(turnId))
    expect(first.allowed).toBe(true)
    const second = await budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, usd, audit(turnId))
    expect(second.allowed).toBe(false)
    expect(await allocated()).toBe(usd)
    // Another turn of the same user and scope is independent.
    expect((await budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, usd, audit(randomUUID()))).allowed).toBe(true)
    expect(await allocated()).toBe(2 * usd)
  })

  test('the turn guard is isolated by user and scope', async () => {
    const turnId = randomUUID()
    const reserve = (userId: string, scope: string) =>
      budget.reserveAttempt(randomUUID(), userId, scope, provider, usd, audit(turnId))
    const results = await Promise.all([reserve(actor.userId, scopeId), reserve(actor.userId, 'other-scope'), reserve('other-user', scopeId)])
    expect(results.map(r => r.allowed)).toEqual([true, true, true])
  })

  test('concurrent reservations for one turn allow exactly one', async () => {
    const turnId = randomUUID()
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, usd, audit(turnId))))
    expect(results.filter(r => r.allowed)).toHaveLength(1)
    expect(await allocated()).toBe(usd)
  })

  test('a rejected duplicate leaves the counters, the attempt rows and the ledger untouched', async () => {
    const turnId = randomUUID()
    const winner = randomUUID()
    const loser = randomUUID()
    await budget.reserveAttempt(winner, actor.userId, scopeId, provider, usd, audit(turnId))
    await budget.reserveAttempt(loser, actor.userId, scopeId, provider, usd, audit(turnId))
    expect(await budget.getAttempt(loser)).toBeUndefined()
    expect(await budget.getAttempt(winner)).toMatchObject({ state: 'reserved', turnId })
    expect(await store.read('MODEL-BUDGET#' + month, 'PROVIDER#' + provider)).toMatchObject({ allocated: usd })
  })
})

describe('failure between the send and the recorded result', () => {
  test('settlement_write_failure_after_send_keeps_the_reservation_and_never_resends', async () => {
    const ref = await accept()
    const transport = normalTransport()
    const handler = handlerFor(transport)
    vi.spyOn(budget, 'settleAttempt').mockRejectedValueOnce(transient())
    vi.spyOn(store, 'markPublished').mockRejectedValueOnce(transient())
    await expect(publishOutbox(store, queue, ref)).rejects.toThrow()
    expect(await deliver(queue, time, handler)).toBe('deleted')
    // The provider answered, but its charge was not recorded: the turn is uncertain and the money stays held.
    expect(await turn(ref)).toMatchObject({ status: 'incomplete', error: { code: 'SEND_UNCERTAIN' } })
    const row = await expectSingleReservation(ref, transport, 'reserved')
    expect(await allocated()).toBe(row.maxCost)
    // A duplicate delivery after the window resolves the terminal turn without another call.
    time += DEDUPLICATION_WINDOW_MS + second
    await publishOutbox(store, queue, ref)
    expect(await deliver(queue, time, handler)).toBe('deleted')
    await expectSingleReservation(ref, transport, 'reserved')
    // Later reconciliation with the usage evidence settles it once, with the real charge.
    await budget.settleAttempt(row.attemptId, { kind: 'reported', usage })
    expect(await budget.getAttempt(row.attemptId)).toMatchObject({ state: 'settled', costMicros: 59 })
    expect(await allocated()).toBe(59)
  })
})
