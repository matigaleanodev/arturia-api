// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createWorkerHandler } from '../../src/chat/generate.lambda.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import { ModelBudget, costMicros, type Tariff } from '../../src/models/budget.js'
import { MAX_INPUT_BYTES, type InputCalibration } from '../../src/models/budget-bound.js'
import { createCatalogTurnProvider as createEnabled } from '../../src/models/catalog.js'
import { createCatalogTurnProvider } from '../support/all-providers.js'
import { createTurnDispatcher, type ModelTransport } from '../../src/models/dispatch.js'
import type { ModelWire } from '../../src/models/wire.js'
import { integrationDatabase } from '../support/dynamodb.js'

let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let budget: ModelBudget
let time = Date.UTC(2060, 5, 1)
const usd = 1_000_000
const scopeId = 'bound-scope'
let actor: { userId: string; sessionId: string }
const pk = () => scopePartition(actor.userId, scopeId)
const write = (pk: string, sk: string, fields: Record<string, unknown>) =>
  store.db.send(new PutCommand({ TableName: store.tableName, Item: { pk, sk, ...fields } }))
const grant = { enabled: true, origins: ['direct'], categories: ['chat'], integrations: ['manual'] }
const base = { verifiedAt: Date.UTC(2025, 0), expiresAt: Date.UTC(2090, 0), toolCall: 0 }
const tariffs: Record<string, Tariff> = {
  openai: { ...base, inputPerMillion: 200_000, outputPerMillion: 750_000,
    shortContext: { maxInputTokens: 272_000, inputPerMillion: 100_000, outputPerMillion: 500_000 } },
  anthropic: { ...base, inputPerMillion: 2_000_000, outputPerMillion: 10_000_000 },
}
const models = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' }
const selection = (provider: 'openai' | 'anthropic', maxOutputTokens = 64) => ({
  enabled: true, provider, model: models[provider], maxOutputTokens, tariff: tariffs[provider],
})
const reply = (events: unknown[]) => new Response(
  events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
const anthropicReply = (inputTokens = 11, outputTokens = 9) => reply([
  { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 1 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } },
  { type: 'message_stop' },
])
const calibration: InputCalibration = { framingTokens: 64, source: 'provider-token-count-fixture', samples: [{ bytes: 20, tokens: 12 }] }

beforeEach(async () => {
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  actor = { userId: randomUUID(), sessionId: 'bound-session' }
  await write(JSON.stringify([actor.userId]), 'ACCOUNT', { status: 'active', mfaVerifiedAt: 1 })
  await write(JSON.stringify([actor.userId]), 'SESSION#bound-session', { status: 'active', authTime: 2 })
  await write(pk(), 'SCOPE', { actions: new Set(['turn:create', 'conversation:create', 'turn:run', 'turn:read', 'turn:stream']) })
  for (const provider of ['openai', 'anthropic', 'fixture-a']) await write(pk(), 'MODEL#' + provider, grant)
})
afterEach(() => local.client.destroy())

async function conversation(text = 'Contenido de prueba') {
  const chat = createChat(store)
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, randomUUID(), { text })
  return { userId: actor.userId, scopeId, turnId: t.turnId }
}
const empty = { reasoningTokens: 0, toolTokens: 0, toolCalls: 0 }

test('reservation_matches_the_limits_sent_to_the_provider', async () => {
  budget = new ModelBudget(store, { anthropic: 3 * usd, openai: usd })
  const text = 'Contenido de prueba'
  for (const provider of ['anthropic', 'openai'] as const) {
    const wire = vi.fn<ModelWire>(async () => provider === 'anthropic' ? anthropicReply() : reply([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } } } },
    ]))
    const ref = await conversation(text)
    const id = randomUUID()
    await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection(provider), wire)).runTurn(ref, id)
    expect(wire).toHaveBeenCalledTimes(1)
    const body = JSON.parse(wire.mock.calls[0][0].body)
    expect(provider === 'anthropic' ? body.max_tokens : body.max_output_tokens).toBe(64)
    const window = provider === 'anthropic' ? 1_000_000 : 1_050_000
    const attempt = await budget.getAttempt(id)
    // The reserved amount is exactly the bound of the limits that left the process: same model, same output cap.
    expect(attempt).toMatchObject({ provider, model: models[provider], state: 'settled',
      maxCost: costMicros(tariffs[provider], { inputTokens: window, outputTokens: 64, ...empty }) })
  }
})

test('calibrated_byte_bound_reduces_the_reservation_and_is_used_as_the_input_limit', async () => {
  budget = new ModelBudget(store, { anthropic: 3 * usd })
  const text = 'Contenido de prueba'
  const wire = vi.fn<ModelWire>(async () => anthropicReply())
  const ref = await conversation(text)
  const id = randomUUID()
  await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection('anthropic'), wire,
    { calibration: { 'claude-sonnet-5-5': calibration } })).runTurn(ref, id)
  const bound = Buffer.byteLength(text, 'utf8') + 64
  expect(await budget.getAttempt(id)).toMatchObject({ state: 'settled',
    maxCost: costMicros(tariffs.anthropic, { inputTokens: bound, outputTokens: 64, ...empty }) })
})

test('usage_above_the_reserved_bound_is_failed_and_settled_at_the_reported_cost', async () => {
  budget = new ModelBudget(store, { anthropic: 3 * usd })
  const text = 'Contenido de prueba'
  const bound = Buffer.byteLength(text, 'utf8') + 64
  const wire = vi.fn<ModelWire>(async () => anthropicReply(bound + 1, 9))
  const ref = await conversation(text)
  const id = randomUUID()
  await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection('anthropic'), wire,
    { calibration: { 'claude-sonnet-5-5': calibration } })).runTurn(ref, id)
  expect(wire).toHaveBeenCalledTimes(1)
  // A calibration that under-counted is evidence of a wrong bound: the attempt fails, but the charge is recorded.
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ error: { code: 'GENERATION_FAILED' } })
  expect(await budget.getAttempt(id)).toMatchObject({ state: 'settled',
    costMicros: costMicros(tariffs.anthropic, { inputTokens: bound + 1, outputTokens: 9, ...empty }) })
})

test('cap_below_attempt_bound_never_reserves_or_sends', async () => {
  budget = new ModelBudget(store, { anthropic: 2 * usd })
  const wire = vi.fn<ModelWire>()
  const ref = await conversation()
  const id = randomUUID()
  await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection('anthropic', 4096), wire)).runTurn(ref, id)
  expect(wire).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked' })
})

test('input_over_the_limit_never_reserves_or_sends', async () => {
  budget = new ModelBudget(store, { openai: usd })
  const wire = vi.fn<ModelWire>()
  const ref = await conversation('a'.repeat(MAX_INPUT_BYTES))
  // The accepted maximum passes; one extra byte of normalized text must be refused before the reservation.
  const row = await store.read(turnKey(ref).pk, turnKey(ref).sk)
  await write(pk(), row!.messageSk, { ...(await store.read(pk(), row!.messageSk)), text: 'a'.repeat(MAX_INPUT_BYTES + 1) })
  const id = randomUUID()
  await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection('openai'), wire)).runTurn(ref, id)
  expect(wire).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
})

const config = () => ({ provider: 'fixture-a', model: 'fixture-model', tariff: { ...tariffs.anthropic }, limits: { outputTokens: 100, ...empty } })
function hangingTransport() {
  return {
    inputTokenBound: (text: string) => Buffer.byteLength(text, 'utf8') + 12,
    stream: vi.fn<ModelTransport['stream']>(async function* (request) {
      yield { type: 'text', text: 'parcial' }
      await new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }),
  }
}

test('runtime_deadline_is_clamped_to_the_remaining_invocation_time_and_keeps_the_reservation', async () => {
  budget = new ModelBudget(store, { 'fixture-a': 6 * usd })
  const port = hangingTransport()
  const ref = await conversation()
  const worker = createGenerationWorker(store, createTurnDispatcher(store, budget, config, port),
    { timeoutMs: 30_000, pollMs: 10, closeMarginMs: 200, minProviderMs: 50 })
  const id = randomUUID()
  const started = performance.now()
  // 600 ms left in the invocation: the provider gets 400 ms, not the configured 30 s.
  expect(await worker.runTurn(ref, id, () => 600)).toBe('done')
  expect(performance.now() - started).toBeLessThan(2500)
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'incomplete', error: { code: 'GENERATION_TIMEOUT' } })
  // The charge is unknown: the whole reservation stays, and a redelivery never calls the provider again.
  expect(await budget.getAttempt(id)).toMatchObject({ state: 'reserved' })
  expect(await worker.runTurn(ref, randomUUID(), () => 600)).toBe('done')
  expect(port.stream).toHaveBeenCalledTimes(1)
})

test('not_enough_remaining_time_retries_before_claiming_or_reserving', async () => {
  budget = new ModelBudget(store, { 'fixture-a': 6 * usd })
  const port = hangingTransport()
  const ref = await conversation()
  const worker = createGenerationWorker(store, createTurnDispatcher(store, budget, config, port))
  const id = randomUUID()
  // Default margin 10 s and minimum provider window 5 s: 12 s left is not enough.
  expect(await worker.runTurn(ref, id, () => 12_000)).toBe('retry')
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  const row = await store.read(turnKey(ref).pk, turnKey(ref).sk)
  expect(row?.status).not.toBe('running')
  expect(row?.leaseId).toBeUndefined()
  expect(row?.sendState).toBeUndefined()
})

test('window_that_shrinks_after_the_claim_retries_before_persisting_the_send_intent', async () => {
  budget = new ModelBudget(store, { 'fixture-a': 6 * usd })
  const port = hangingTransport()
  const ref = await conversation()
  const worker = createGenerationWorker(store, createTurnDispatcher(store, budget, config, port),
    { timeoutMs: 30_000, pollMs: 10, closeMarginMs: 200, minProviderMs: 300 })
  const id = randomUUID()
  let calls = 0
  // The guard before the claim sees 1000 ms; by the time the intent would be persisted only 100 ms are left.
  expect(await worker.runTurn(ref, id, () => (++calls <= 1 ? 1000 : 300))).toBe('retry')
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  const row = await store.read(turnKey(ref).pk, turnKey(ref).sk)
  expect(row?.sendState).toBeUndefined()
  // The lease expires and a later invocation with time left runs the turn normally.
  time += 10 * 60_000
  expect(await worker.runTurn(ref, randomUUID(), () => 1500)).toBe('done')
  expect(port.stream).toHaveBeenCalledTimes(1)
})

test('window_below_the_minimum_after_the_intent_never_reaches_the_provider', async () => {
  budget = new ModelBudget(store, { 'fixture-a': 6 * usd })
  const port = hangingTransport()
  const ref = await conversation()
  const worker = createGenerationWorker(store, createTurnDispatcher(store, budget, config, port),
    { timeoutMs: 30_000, pollMs: 10, closeMarginMs: 200, minProviderMs: 300 })
  const id = randomUUID()
  let calls = 0
  // Enough time at the guard and before the intent, none by the time the provider would be called.
  expect(await worker.runTurn(ref, id, () => (++calls <= 2 ? 1000 : 400))).toBe('done')
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'failed', error: { code: 'GENERATION_TIMEOUT' } })
})

test('worker_rejects_inconsistent_close_margin_or_lease', () => {
  const provider = { stream: () => (async function* () { /* never used */ })() }
  for (const options of [{ closeMarginMs: 0 }, { closeMarginMs: -1 }, { closeMarginMs: 1.5 }, { minProviderMs: 0 },
    { timeoutMs: 1000, leaseMs: 1500, closeMarginMs: 600 }, { timeoutMs: 1000, leaseMs: 1100, closeMarginMs: 100 }]) {
    expect(() => createGenerationWorker(store, provider, options), JSON.stringify(options)).toThrow(RangeError)
  }
  expect(() => createGenerationWorker(store, provider, { timeoutMs: 1000, leaseMs: 1200, closeMarginMs: 100 })).not.toThrow()
})

test('worker_handler_passes_the_remaining_invocation_time_to_the_turn_runner', async () => {
  const run = vi.fn(async (_ref: unknown, _attemptId: string, remaining?: () => number) => { void remaining; return 'done' as const })
  const handler = createWorkerHandler({ run, log: () => {} })
  const body = JSON.stringify({ userId: 'u', scopeId: 's', turnId: 't' })
  await handler({ Records: [{ messageId: 'm1', body }] }, { getRemainingTimeInMillis: () => 1234 })
  expect(run.mock.calls[0][2]?.()).toBe(1234)
})

test('disabled_provider_is_never_selected_reserved_or_sent', async () => {
  budget = new ModelBudget(store, { anthropic: 6 * usd, openai: 6 * usd })
  const wire = vi.fn<ModelWire>(async () => anthropicReply())
  const ref = await conversation()
  const id = randomUUID()
  // The default of the catalog enables OpenAI only: a selection of Anthropic fails closed, with no fallback.
  await createGenerationWorker(store, createEnabled(store, budget, () => selection('anthropic'), wire)).runTurn(ref, id)
  expect(wire).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked' })
})
