// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { PutCommand, TransactGetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { ChatStore, scopePartition } from '../../src/chat/turns.store.js'
import { createStreamReader, dynamoStreamSource } from '../../src/chat/stream.reader.js'
import { createChat } from '../../src/chat/turns.js'
import { cancelTurn } from '../../src/chat/cancel.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createCatalogTurnProvider } from '../../src/models/catalog.js'
import type { ModelWire } from '../../src/models/wire.js'
import { ModelBudget, costMicros, type Tariff } from '../../src/models/budget.js'
import { createTurnDispatcher, dispatchModel, type ModelTransport } from '../../src/models/dispatch.js'
import { integrationDatabase } from '../support/dynamodb.js'

let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let time: number
let month = 0
let budget: ModelBudget
const usd = 1_000_000
const price: Tariff = {
  inputPerMillion: 300_000, outputPerMillion: 1_100_000, toolCall: 23,
  verifiedAt: Date.UTC(2025, 0), expiresAt: Date.UTC(2040, 0),
}
const usage = { inputTokens: 3, outputTokens: 2, reasoningTokens: 4, toolTokens: 5, toolCalls: 2 }
const limits = { outputTokens: 100, reasoningTokens: 50, toolTokens: 30, toolCalls: 2 }
const scopeId = 'fixture-scope'
const provider = 'fixture-a'
const model = 'fixture-model'
let actor: { userId: string; sessionId: string }
const pk = () => scopePartition(actor.userId, scopeId)
const write = (pk: string, sk: string, fields: Record<string, unknown>) =>
  store.db.send(new PutCommand({ TableName: store.tableName, Item: { pk, sk, ...fields } }))
const goodGrant = { enabled: true, origins: ['direct', 'fixture-bank'], categories: ['chat'], integrations: ['manual'] }

beforeEach(async () => {
  time = Date.UTC(2026, month++, 1)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  budget = new ModelBudget(store, { [provider]: 6 * usd, 'fixture-b': 6 * usd })
  actor = { userId: randomUUID(), sessionId: 'fixture-session' }
  await write(JSON.stringify([actor.userId]), 'ACCOUNT', { status: 'active', mfaVerifiedAt: 1 })
  await write(JSON.stringify([actor.userId]), 'SESSION#fixture-session', { status: 'active', authTime: 2 })
  await write(pk(), 'SCOPE', { actions: new Set(['turn:create', 'conversation:create', 'turn:run', 'turn:read', 'turn:stream']) })
  await write(pk(), 'MODEL#' + provider, goodGrant)
})
afterEach(() => local.client.destroy())

async function conversation(text = 'Contenido de prueba') {
  const chat = createChat(store)
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, 'fixture-key', { text })
  return { userId: actor.userId, scopeId, turnId: t.turnId }
}

const config = () => ({ provider, model, tariff: price, limits })
const transport = () => ({
  inputTokenBound: (text: string) => Buffer.byteLength(text, 'utf8') + 12,
  stream: vi.fn<ModelTransport['stream']>(async function* () {
    yield { type: 'text', text: 'Respuesta' }
    yield { type: 'usage', usage }
  }),
})

test('global_budget_cannot_be_overspent_concurrently', async () => {
  const results = await Promise.all([
    budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, 6 * usd),
    budget.reserveAttempt(randomUUID(), 'other-user', 'other-scope', 'fixture-b', 6 * usd),
  ])
  expect(results.map(r => r.allowed).sort()).toEqual([false, true])
  const winner = results[0].allowed ? provider : 'fixture-b'
  expect((await budget.reserveAttempt(randomUUID(), actor.userId, scopeId, winner, 1)).allowed).toBe(false)
})

test('settlement_is_idempotent_and_uses_the_original_utc_month', async () => {
  const id = randomUUID()
  const reserve = (amount: number) => budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, amount)
  expect((await budget.reserveAttempt(id, actor.userId, scopeId, provider, 6 * usd)).allowed).toBe(true)
  const originalTime = time
  time = Date.UTC(2051, 3)
  const receipt = { kind: 'invoice', costMicros: 2 * usd } as const
  await Promise.all([budget.settleAttempt(id, receipt), budget.settleAttempt(id, receipt)])
  await expect(budget.settleAttempt(id, { ...receipt, costMicros: usd })).rejects.toThrow()
  expect((await reserve(6 * usd)).allowed).toBe(true)
  time = originalTime
  expect((await reserve(4 * usd)).allowed).toBe(true)
  expect((await reserve(1)).allowed).toBe(false)
})

test('unknown_charge_keeps_reservation', async () => {
  const ref = await conversation()
  const port = transport()
  port.stream.mockImplementation(async function* () { yield { type: 'text', text: 'parcial' }; throw new Error('synthetic timeout') })
  const id = randomUUID()
  const worker = createGenerationWorker(store, createTurnDispatcher(store, budget, config, port))
  await worker.runTurn(ref, id)
  await worker.runTurn(ref, randomUUID())
  expect(port.stream).toHaveBeenCalledTimes(1)
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'incomplete', error: { code: 'SEND_UNCERTAIN' } })
  expect((await budget.reserveAttempt(id, actor.userId, scopeId, provider, 1)).allowed).toBe(false)
  expect((await budget.reserveAttempt(randomUUID(), actor.userId, scopeId, provider, 6 * usd)).allowed).toBe(false)
  await budget.settleAttempt(id, { kind: 'reported', usage })
  expect(await budget.getAttempt(id)).toMatchObject({ costMicros: 59, usage })
})

test.each(['bank', 'category', 'integration', 'unknown-source', 'secret', 'disabled'])(
  'disallowed_data_never_leaves_backend (%s)', async reason => {
    const ref = await conversation(reason === 'secret' ? 'Authorization: Bearer synthetic-example-only' : undefined)
    const { messageSk } = (await store.read(pk(), 'TURN#' + ref.turnId))!
    const source = { origin: 'direct', kind: 'chat', category: 'chat', integration: 'manual' }
    if (reason === 'bank') Object.assign(source, { origin: 'fixture-bank', kind: 'bank' })
    if (reason === 'category') source.category = 'sensitive'
    if (reason === 'integration') source.integration = 'revoked'
    if (reason === 'unknown-source') source.origin = 'unclassified'
    await store.db.send(new UpdateCommand({ TableName: store.tableName, Key: { pk: pk(), sk: messageSk },
      UpdateExpression: 'SET modelSources = :sources', ExpressionAttributeValues: { ':sources': [source] } }))
    if (reason === 'disabled') await write(pk(), 'MODEL#' + provider, { ...goodGrant, enabled: false })
    const port = transport()
    await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, randomUUID())
    expect(port.stream).not.toHaveBeenCalled()
    expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked', lastSeq: 0 })
  })

test('revoked_after_reservation_before_background_send', async () => {
  const ref = await conversation()
  const reserve = budget.reserveAttempt.bind(budget)
  vi.spyOn(budget, 'reserveAttempt').mockImplementation(async (...args) => {
    const result = await reserve(...args)
    await write(pk(), 'MODEL#' + provider, { ...goodGrant, categories: [] })
    return result
  })
  const port = transport()
  const id = randomUUID()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, id)
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toMatchObject({ costMicros: 0 })
})

test.each(['missing', 'expired', 'future'])('unverified_tariff_denies_egress (%s)', async reason => {
  const ref = await conversation()
  const tariff = reason === 'missing' ? undefined : { ...price,
    ...(reason === 'expired' ? { expiresAt: time } : { verifiedAt: time + 1 }) }
  const port = transport()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, () => ({ ...config(), tariff }), port)).runTurn(ref, randomUUID())
  expect(port.stream).not.toHaveBeenCalled()
})

test('prices_all_billable_dimensions_and_audits_without_payload', async () => {
  const text = 'Texto sintético privado'
  const ref = await conversation(text)
  const id = randomUUID()
  const port = transport()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, id)
  expect(port.stream).toHaveBeenCalledTimes(1)
  const request = port.stream.mock.calls[0][0]
  expect(request).toMatchObject({ text, limits })
  const row = await budget.getAttempt(id)
  expect(costMicros(price, usage)).toBe(59)
  expect(row).toMatchObject({ provider, model, operation: 'chat', tariff: price, usage, costMicros: 59,
    maxCost: costMicros(price, { ...limits, inputTokens: port.inputTokenBound(text) }) })
  expect(JSON.stringify(row)).not.toContain(text)
  expect(JSON.stringify(row)).not.toContain('Respuesta')
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'completed' })
})
test('source_registry_requires_current_read_access_independently_of_provider_sharing', async () => {
  const ref = await conversation()
  const { messageSk } = (await store.read(pk(), 'TURN#' + ref.turnId))!
  const source = { origin: 'repo-1', kind: 'repository', category: 'code', integration: 'repo-integration' }
  await store.db.send(new UpdateCommand({ TableName: store.tableName, Key: { pk: pk(), sk: messageSk },
    UpdateExpression: 'SET modelSources = :s', ExpressionAttributeValues: { ':s': [source] } }))
  await write(pk(), 'MODEL#' + provider, { enabled: true, origins: ['repo-1'], categories: ['code'], integrations: ['repo-integration'] })
  const setAccess = (kind: string) => write(pk(), 'MODEL-SOURCES', { origins: { 'repo-1': { kind, integration: 'repo-integration' } },
    categories: ['code'], integrations: ['repo-integration'] })
  await setAccess('repository')
  const reserve = budget.reserveAttempt.bind(budget)
  vi.spyOn(budget, 'reserveAttempt').mockImplementation(async (...args) => {
    const result = await reserve(...args)
    // Classification was corrected after a context was prepared. Sharing permissions still exist.
    await setAccess('bank')
    return result
  })
  const port = transport()
  const id = randomUUID()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, id)
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toMatchObject({ costMicros: 0 })
})

test('calendar_rollover_requires_a_new_authorized_reservation', async () => {
  time = Date.UTC(2035, 0, 31, 23, 59, 59, 990)
  const ref = await conversation()
  const reserve = budget.reserveAttempt.bind(budget)
  vi.spyOn(budget, 'reserveAttempt').mockImplementation(async (...args) => {
    const result = await reserve(...args)
    time += 20
    return result
  })
  const port = transport()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, randomUUID())
  expect(port.stream).not.toHaveBeenCalled()
})
test('background_context_with_unknown_provenance_is_not_a_direct_user_message', async () => {
  const port = transport()
  const job = { attemptId: randomUUID(), userId: actor.userId, scopeId, operation: 'automation' as const,
    signal: new AbortController().signal, readAuthorizedContext: async () => ({ message: { text: 'Unresolved fixture' }, grant: goodGrant }) }
  await expect(dispatchModel(budget, store.now, config, port, job).next()).rejects.toThrow()
  expect(port.stream).not.toHaveBeenCalled()
})

test.each(['Origen: banco', 'Source: banking'])('blocks declared banking content (%s)', async origin => {
  const ref = await conversation(origin + '\nContenido sintético')
  const port = transport()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, randomUUID())
  expect(port.stream).not.toHaveBeenCalled()
})

test('revoked_session_at_outbound_boundary_stops_the_transport', async () => {
  const ref = await conversation()
  const reserve = budget.reserveAttempt.bind(budget)
  vi.spyOn(budget, 'reserveAttempt').mockImplementation(async (...args) => {
    const result = await reserve(...args)
    await write(JSON.stringify([actor.userId]), 'SESSION#fixture-session', { status: 'revoked' })
    return result
  })
  const port = transport()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, randomUUID())
  expect(port.stream).not.toHaveBeenCalled()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked' })
})

test('bank_classification_overrides_source_access_and_provider_sharing', async () => {
  const ref = await conversation()
  const { messageSk } = (await store.read(pk(), 'TURN#' + ref.turnId))!
  const source = { origin: 'repo-1', kind: 'repository', category: 'bank', integration: 'repo-integration' }
  await store.db.send(new UpdateCommand({ TableName: store.tableName, Key: { pk: pk(), sk: messageSk },
    UpdateExpression: 'SET modelSources = :sources', ExpressionAttributeValues: { ':sources': [source] } }))
  await write(pk(), 'MODEL-SOURCES', { origins: { 'repo-1': { kind: 'repository', integration: 'repo-integration' } },
    categories: ['bank'], integrations: ['repo-integration'] })
  await write(pk(), 'MODEL#' + provider, { enabled: true, origins: ['repo-1'], categories: ['bank'], integrations: ['repo-integration'] })
  const port = transport()
  const id = randomUUID()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, id)
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked', lastSeq: 0 })
})

test('duplicate_dispatch_and_redrive_cannot_reuse_a_reservation', async () => {
  const attemptId = randomUUID()
  const port = transport()
  port.stream.mockImplementation(async function* () {
    expect(await budget.getAttempt(attemptId)).toMatchObject({ state: 'reserved', userId: actor.userId, scopeId })
    yield { type: 'usage', usage }
  })
  const job = { attemptId, userId: actor.userId, scopeId, operation: 'automation' as const,
    signal: new AbortController().signal, readAuthorizedContext: async () => ({
      message: { text: 'Synthetic job', modelSources: [{ kind: 'chat', origin: 'direct', integration: 'manual', category: 'chat' }] },
      grant: goodGrant,
    }) }
  const dispatch = () => dispatchModel(budget, store.now, config, port, job).next()
  const results = await Promise.allSettled([dispatch(), dispatch()])
  expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  await expect(dispatch()).rejects.toThrow()
  expect(port.stream).toHaveBeenCalledTimes(1)
  expect(await budget.getAttempt(attemptId)).toMatchObject({ state: 'settled', costMicros: 59 })
})

test('another user or scope cannot reuse the chat lease or its egress grant', async () => {
  const ref = await conversation()
  const key = 'TURN#' + ref.turnId
  const { messageSk } = (await store.read(pk(), key))!
  const port = transport()
  const gate = createTurnDispatcher(store, budget, config, port)
  const attemptId = randomUUID()
  const worker = createGenerationWorker(store, { async *stream(request) {
    for (const isolatedRef of [{ ...ref, userId: randomUUID() }, { ...ref, scopeId: 'other-scope' }]) {
      const reader = gate.stream({ ...request, ref: isolatedRef, messageSk })[Symbol.asyncIterator]()
      await expect(reader.next()).rejects.toThrow()
      expect(await budget.getAttempt(attemptId)).toBeUndefined()
    }
    yield* gate.stream(request)
  } })
  await worker.runTurn(ref, attemptId)
  expect(port.stream).toHaveBeenCalledTimes(1)
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'completed' })
})

test.each(['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'])('blocks a configured credential named %s', async name => {
  const ref = await conversation(name + '=synthetic-placeholder-only')
  const port = transport()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, randomUUID())
  expect(port.stream).not.toHaveBeenCalled()
})

test('retries a transient authorization snapshot conflict before sending', async () => {
  const ref = await conversation()
  const send = store.db.send.bind(store.db)
  let reads = 0
  const spy = vi.spyOn(store.db, 'send').mockImplementation(async (command, options) => {
    if (command instanceof TransactGetCommand && ++reads === 1) {
      throw new TransactionCanceledException({
        message: 'fixture conflict', $metadata: {}, CancellationReasons: [{ Code: 'TransactionConflict' }],
      })
    }
    return send(command, options)
  })
  try {
    const port = transport()
    await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, randomUUID())
    expect(reads).toBe(3)
    expect(port.stream).toHaveBeenCalledTimes(1)
    expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'completed' })
  } finally {
    spy.mockRestore()
  }
})

test('over_budget_chat_never_calls_the_transport_and_emits_a_blocked_terminal', async () => {
  const ref = await conversation()
  const full = await budget.reserveAttempt(randomUUID(), 'another-user', 'another-scope', provider, 6 * usd)
  expect(full.allowed).toBe(true)
  const port = transport()
  const id = randomUUID()
  await createGenerationWorker(store, createTurnDispatcher(store, budget, config, port)).runTurn(ref, id)
  expect(port.stream).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  const { readStream } = createStreamReader(dynamoStreamSource(store))
  const frames: string[] = []
  for await (const frame of readStream(actor, scopeId, ref.turnId, 0)) frames.push(frame)
  expect(frames).toHaveLength(1)
  expect(frames[0]).toBe('event: status\ndata: ' +
    JSON.stringify({ type: 'status', turnId: ref.turnId, status: 'blocked', lastSeq: 0 }) + '\n\n')
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({
    status: 'blocked', error: { code: 'MODEL_POLICY_DENIED' },
  })
})

const candidateTariffs = {
  openai: { ...price, inputPerMillion: 200_000, outputPerMillion: 750_000, toolCall: 0,
    shortContext: { maxInputTokens: 272_000, inputPerMillion: 100_000, outputPerMillion: 500_000 } },
  anthropic: { ...price, inputPerMillion: 2_000_000, outputPerMillion: 10_000_000, toolCall: 0 },
}
const candidateModels = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' }
const settings = (provider: keyof typeof candidateModels = 'openai') => ({
  enabled: true, provider, model: candidateModels[provider], maxOutputTokens: 64, tariff: candidateTariffs[provider],
})
const modelReply = (events: unknown[]) => new Response(
  events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
  { headers: { 'content-type': 'text/event-stream' } },
)
const openAIText = { type: 'response.output_text.delta', delta: 'Parcial sintético' }
const openAITerminal = (status: string) => ({
  type: 'response.' + status, response: { status, error: { message: 'private-error-fixture' },
    usage: { input_tokens: 12, output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 } } },
})

test.each(['completed', 'failed', 'error'] as const)('catalog reconciles the worker attempt (%s)', async result => {
  await write(pk(), 'MODEL#openai', goodGrant)
  budget = new ModelBudget(store, { openai: usd })
  const wire = vi.fn<ModelWire>(async () => modelReply([openAIText,
    result === 'error' ? { type: 'error', error: { message: 'private-error-fixture' } } : openAITerminal(result),
  ]))
  const ref = await conversation()
  const id = randomUUID()
  const worker = createGenerationWorker(store, createCatalogTurnProvider(store, budget, settings, wire))
  await worker.runTurn(ref, id)
  await worker.runTurn(ref, randomUUID())
  expect(wire).toHaveBeenCalledTimes(1)
  expect(wire.mock.calls[0][0]).toMatchObject({ provider: 'openai', path: '/v1/responses' })
  expect(wire.mock.calls[0][0].body).not.toContain(actor.userId)
  expect(wire.mock.calls[0][0].body).not.toContain(scopeId)
  const row = await store.getTurn(pk(), ref.turnId)
  expect(row).toMatchObject({ status: result === 'completed' ? 'completed' : 'incomplete', lastSeq: 1 })
  expect(JSON.stringify(row)).not.toContain('private-error-fixture')
  const attempt = await budget.getAttempt(id)
  expect(attempt).toMatchObject({ userId: actor.userId, scopeId, provider: 'openai', model: 'gpt-6-luna' })
  if (result === 'error') {
    expect(row).toMatchObject({ error: { code: 'SEND_UNCERTAIN' } })
    expect(attempt).toMatchObject({ state: 'reserved' })
  } else {
    expect(attempt).toMatchObject({ state: 'settled', costMicros: 6,
      usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 3 } })
    if (result === 'failed') expect(row).toMatchObject({ error: { code: 'GENERATION_FAILED' } })
  }
})

test('Anthropic is selected only for its own authorized provider and turn scope', async () => {
  const ref = await conversation()
  budget = new ModelBudget(store, { anthropic: 3 * usd })
  const wire = vi.fn<ModelWire>(async () => modelReply([
    { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]))
  const gateway = createCatalogTurnProvider(store, budget, () => settings('anthropic'), wire)
  const worker = createGenerationWorker(store, gateway)
  await write(pk(), 'MODEL#openai', goodGrant)
  await write(scopePartition('other-user', scopeId), 'MODEL#anthropic', goodGrant)
  await write(scopePartition(actor.userId, 'other-scope'), 'MODEL#anthropic', goodGrant)
  await worker.runTurn(ref, randomUUID())
  expect(wire).not.toHaveBeenCalled()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked' })

  await write(pk(), 'MODEL#anthropic', goodGrant)
  const chat = createChat(store)
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, 'anthropic-turn', { text: 'Otro mensaje' })
  const attemptId = randomUUID()
  await worker.runTurn({ ...ref, turnId: t.turnId }, attemptId)
  expect(wire).toHaveBeenCalledTimes(1)
  expect(wire.mock.calls[0][0]).toMatchObject({ provider: 'anthropic', path: '/v1/messages' })
  expect(await budget.getAttempt(attemptId)).toMatchObject({ state: 'settled', costMicros: 112 })
})

test.each([
  { enabled: false }, { provider: 'unknown' }, { model: 'claude-sonnet-5-5' }, { maxOutputTokens: 15 },
  { tariff: { ...candidateTariffs.openai, inputPerMillion: 100_000 } },
])('invalid catalog configuration never reserves or sends (%j)', async override => {
  await write(pk(), 'MODEL#openai', goodGrant)
  budget = new ModelBudget(store, { openai: usd })
  const wire = vi.fn<ModelWire>()
  const ref = await conversation()
  const id = randomUUID()
  const worker = createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => ({ ...settings(), ...override }), wire))
  await worker.runTurn(ref, id)
  expect(wire).not.toHaveBeenCalled()
  expect(await budget.getAttempt(id)).toBeUndefined()
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked', lastSeq: 0 })
})

test('worker cancellation aborts the wire and keeps the quoted reservation', async () => {
  await write(pk(), 'MODEL#openai', goodGrant)
  await write(pk(), 'SCOPE', { actions: new Set(['turn:create', 'conversation:create', 'turn:run', 'turn:read', 'turn:cancel']) })
  budget = new ModelBudget(store, { openai: usd })
  const close = vi.fn()
  const wire = vi.fn<ModelWire>(async () => new Response(new ReadableStream({
    start(body) { body.enqueue(Buffer.from('data: ' + JSON.stringify(openAIText) + '\n\n')) },
    cancel: close,
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const ref = await conversation()
  const id = randomUUID()
  const worker = createGenerationWorker(store, createCatalogTurnProvider(store, budget, settings, wire), { pollMs: 10, timeoutMs: 5000 })
  const running = worker.runTurn(ref, id)
  try {
    await vi.waitFor(async () => {
      expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'running', lastSeq: 1 })
    }, { timeout: 4000 })
    await cancelTurn(store, actor, ref)
  } finally {
    await running
  }
  await worker.runTurn(ref, randomUUID())
  expect(wire).toHaveBeenCalledTimes(1)
  expect(wire.mock.calls[0][0].signal.aborted).toBe(true)
  expect(close).toHaveBeenCalledTimes(1)
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'cancelled', lastSeq: 1 })
  expect(await budget.getAttempt(id)).toMatchObject({ state: 'reserved', maxCost: 210_048 })
})

test('catalog revalidates selection after reserving, crediting unsent attempts', async () => {
  await write(pk(), 'MODEL#openai', goodGrant)
  budget = new ModelBudget(store, { openai: usd })
  const reserve = budget.reserveAttempt.bind(budget)
  let enabled = true
  vi.spyOn(budget, 'reserveAttempt').mockImplementation(async (...args) => {
    const result = await reserve(...args)
    enabled = false
    return result
  })
  const wire = vi.fn<ModelWire>()
  const ref = await conversation()
  const attemptId = randomUUID()
  const gateway = createCatalogTurnProvider(store, budget, () => ({ ...settings(), enabled }), wire)
  await createGenerationWorker(store, gateway).runTurn(ref, attemptId)
  expect(wire).not.toHaveBeenCalled()
  expect(await budget.getAttempt(attemptId)).toMatchObject({ state: 'settled', costMicros: 0 })
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'blocked' })
})

test.each([[0, 0], [12, 170]])('Claude refusal retains reported usage with %i output tokens', async (outputTokens, costMicros) => {
  await write(pk(), 'MODEL#anthropic', goodGrant)
  budget = new ModelBudget(store, { anthropic: 3 * usd })
  const wire = vi.fn<ModelWire>(async () => modelReply([
    { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'general_harms' } },
      usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ]))
  const ref = await conversation()
  const id = randomUUID()
  const gateway = createCatalogTurnProvider(store, budget, () => settings('anthropic'), wire)
  await createGenerationWorker(store, gateway).runTurn(ref, id)
  expect(wire).toHaveBeenCalledTimes(1)
  expect(await budget.getAttempt(id)).toMatchObject({ state: 'settled', costMicros, usage: { inputTokens: 25, outputTokens } })
  expect(await store.getTurn(pk(), ref.turnId)).toMatchObject({ status: 'failed', lastSeq: 0 })
})

test('Luna pricing crosses the documented threshold after 272000 input tokens', () => {
  const input = (inputTokens: number) => ({ inputTokens, outputTokens: 8, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 })
  expect(costMicros(candidateTariffs.openai, input(272_000))).toBe(27_204)
  expect(costMicros(candidateTariffs.openai, input(272_001))).toBe(54_407)
})
