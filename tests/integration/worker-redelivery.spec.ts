// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TIMING } from '../../src/config/timing.js'
import { createWorkerHandler } from '../../src/chat/generate.lambda.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import { publishOutbox, sqsMessage } from '../../src/jobs/outbox.js'
import type { Provider } from '../../src/models/provider.js'
import { SimulatedProvider } from '../../src/models/simulated.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { FifoTurnQueue, deliver } from '../support/fifo-queue.js'

const actions = ['conversation:create', 'turn:create', 'turn:read', 'turn:cancel', 'turn:run']
const second = 1000
let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let queue: FifoTurnQueue
let actor: { userId: string; sessionId: string }
let time: number

async function accept(scopeId: string, key = 'fixture-key') {
  const chat = createChat(store)
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, key, { text: 'Entrada sintética' })
  return { userId: actor.userId, scopeId, turnId: t.turnId }
}
const turn = (ref: { userId: string; scopeId: string; turnId: string }) => store.read(turnKey(ref).pk, turnKey(ref).sk)
const transient = () => Object.assign(new Error('fixture throttling'), { name: 'ProvisionedThroughputExceededException' })

/** A provider that crosses the send boundary and then hangs, like an invocation killed mid-call. */
function hangingProvider() {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const provider: Provider = { stream: vi.fn(async function* () {
    started.resolve()
    await release.promise
    yield { type: 'text' as const, text: 'Respuesta tardía' }
  }) }
  return { provider, started: started.promise, release: () => release.resolve() }
}
function handlerFor(provider: Provider) {
  let n = 0
  const worker = createGenerationWorker(store, provider)
  return createWorkerHandler({ log: () => {}, newAttemptId: () => `attempt-${++n}`, run: (ref, id) => worker.runTurn(ref, id) })
}

beforeEach(async () => {
  time = Date.UTC(2026, 0, 1)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  queue = new FifoTurnQueue()
  actor = { userId: randomUUID(), sessionId: 'fixture-session' }
  for (const fields of [{ sk: 'ACCOUNT', mfaVerifiedAt: 1 }, { sk: 'SESSION#fixture-session', authTime: 2 }]) {
    await store.db.send(new PutCommand({ TableName: store.tableName, Item: { pk: JSON.stringify([actor.userId]), status: 'active', ...fields } }))
  }
  for (const scopeId of ['fixture-personal', 'fixture-work']) {
    await store.db.send(new PutCommand({ TableName: store.tableName, Item: {
      pk: scopePartition(actor.userId, scopeId), sk: 'SCOPE', actions: new Set(actions) } }))
  }
})
afterEach(() => { vi.restoreAllMocks(); local.client.destroy() })

test('expired_lease_redelivery_keeps_uncertain_state', async () => {
  const ref = await accept('fixture-personal')
  const { provider, started, release } = hangingProvider()
  const handler = handlerFor(provider)
  await publishOutbox(store, queue, ref)
  const receivedAt = time
  const first = queue.receive(time)!
  // The invocation crosses the send boundary and is then killed at its timeout: it never reports.
  const killed = handler({ Records: [first] })
  await started
  try {
    expect(await turn(ref)).toMatchObject({ status: 'running', sendState: 'uncertain', attemptId: 'attempt-1', lastSeq: 0 })
    time = receivedAt + TIMING.workerTimeoutSeconds * second
    expect(queue.receive(time)).toBeUndefined()
    // An at-least-once duplicate while the lease is valid is retried without crossing the boundary.
    expect(await handler({ Records: [first] })).toEqual({ batchItemFailures: [{ itemIdentifier: first.messageId }] })
    // Cut between the lease and the visibility: the lease has expired but nothing is delivered yet.
    time = receivedAt + (TIMING.workerTimeoutSeconds + TIMING.leaseSeconds) * second
    expect(queue.receive(time)).toBeUndefined()
    expect(await turn(ref)).toMatchObject({ status: 'running', sendState: 'uncertain' })
    time = receivedAt + TIMING.turnVisibilitySeconds * second
    expect(await deliver(queue, time, handler)).toBe('deleted')
    expect(await turn(ref)).toMatchObject({ status: 'failed', lastSeq: 0, error: { code: 'SEND_UNCERTAIN' } })
    expect(queue.depth).toEqual({ queued: 0, deadLetters: 0 })
    expect(provider.stream).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await killed
  }
  expect(provider.stream).toHaveBeenCalledTimes(1)
  expect(await turn(ref)).toMatchObject({ status: 'failed', lastSeq: 0 })
  expect(await turn(ref)).not.toHaveProperty('result')
})

test('exhausted_receives_reach_dlq_without_second_call', async () => {
  const ref = await accept('fixture-personal')
  const { provider, started, release } = hangingProvider()
  const handler = handlerFor(provider)
  await publishOutbox(store, queue, ref)
  const first = queue.receive(time)!
  const killed = handler({ Records: [first] })
  await started
  try {
    // Every later receive hits a transient storage failure until the redrive policy moves the message.
    const read = vi.spyOn(store, 'read').mockRejectedValue(transient())
    for (let receive = 2; receive <= TIMING.turnMaxReceives; receive++) {
      time += TIMING.turnVisibilitySeconds * second
      expect(await deliver(queue, time, handler), `receive ${receive}`).toBe('failed')
    }
    time += TIMING.turnVisibilitySeconds * second
    expect(await deliver(queue, time, handler)).toBe('empty')
    expect(queue.depth).toEqual({ queued: 0, deadLetters: 1 })
    read.mockRestore()
    // The turn keeps the first attempt and its uncertain send: nothing was resent or reclaimed.
    expect(await turn(ref)).toMatchObject({ status: 'running', sendState: 'uncertain', attemptId: 'attempt-1', lastSeq: 0 })
    expect(provider.stream).toHaveBeenCalledTimes(1)

    // A manual redrive resolves the expired uncertain lease without another provider call.
    queue.redrive()
    expect(await deliver(queue, time, handler)).toBe('deleted')
    expect(await turn(ref)).toMatchObject({ status: 'failed', lastSeq: 0, error: { code: 'SEND_UNCERTAIN' } })
    expect(queue.depth).toEqual({ queued: 0, deadLetters: 0 })
  } finally {
    release()
    await killed
  }
  expect(provider.stream).toHaveBeenCalledTimes(1)
})

test('retry_does_not_block_other_scope_group', async () => {
  const group = (userId: string, scopeId: string) => sqsMessage('q', { userId, scopeId, turnId: randomUUID() }).MessageGroupId
  expect(group(actor.userId, 'fixture-personal')).toBe(group(actor.userId, 'fixture-personal'))
  expect(group(actor.userId, 'fixture-personal')).not.toBe(group(actor.userId, 'fixture-work'))
  expect(group(actor.userId, 'fixture-personal')).not.toBe(group('other-user', 'fixture-personal'))
  // Ambiguous concatenations cannot collide.
  expect(group('a', 'b,c')).not.toBe(group('a,b', 'c'))

  const blocked = await accept('fixture-personal', 'first')
  const queuedBehind = await accept('fixture-personal', 'second')
  const otherScope = await accept('fixture-work', 'third')
  for (const ref of [blocked, queuedBehind, otherScope]) await publishOutbox(store, queue, ref)
  const provider = new SimulatedProvider(['Uno', ' dos'])
  const stream = vi.spyOn(provider, 'stream')
  const handler = handlerFor(provider)
  const original = store.read.bind(store)
  vi.spyOn(store, 'read').mockImplementation(async (pk, sk) => {
    if (sk === turnKey(blocked).sk) throw transient()
    return original(pk, sk)
  })
  const start = time
  expect(await deliver(queue, time, handler)).toBe('failed')
  // The failed group stays blocked during the visibility; the other scope's group proceeds.
  expect(await deliver(queue, time, handler)).toBe('deleted')
  expect(await turn(otherScope)).toMatchObject({ status: 'completed' })
  expect(await deliver(queue, time, handler)).toBe('empty')
  expect(await turn(queuedBehind)).toMatchObject({ status: 'queued' })

  vi.mocked(store.read).mockRestore()
  time = start + TIMING.turnVisibilitySeconds * second
  expect(await deliver(queue, time, handler)).toBe('deleted')
  expect(await deliver(queue, time, handler)).toBe('deleted')
  for (const ref of [blocked, queuedBehind]) expect(await turn(ref)).toMatchObject({ status: 'completed' })
  expect(stream).toHaveBeenCalledTimes(3)
  expect(queue.depth).toEqual({ queued: 0, deadLetters: 0 })
})
