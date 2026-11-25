// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, scopePartition } from '../../src/chat/turns.store.js'
import { ModelBudget, type Tariff } from '../../src/models/budget.js'
import { createCatalogTurnProvider as createEnabled } from '../../src/models/catalog.js'
import { createCatalogTurnProvider } from '../support/all-providers.js'
import { createFetchWire } from '../../src/models/wire.fetch.js'
import { eventStream, sendEvents, startProviderServer } from '../support/provider-server.js'
import { integrationDatabase } from '../support/dynamodb.js'

let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let budget: ModelBudget
// Every test runs in its own UTC month: a kept reservation counts against the month's cap and must not leak into the next test.
let month = 0
let time = Date.UTC(2060, 0, 1)
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
beforeEach(async () => {
  time = Date.UTC(2060, month++, 1)
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

const keys = { get: async () => 'k'.repeat(24), invalidate: () => undefined }
const servers: Awaited<ReturnType<typeof startProviderServer>>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
type Handler = Parameters<typeof startProviderServer>[0]
async function run(provider: 'openai' | 'anthropic', handler: Handler) {
  const server = await startProviderServer(handler)
  servers.push(server)
  budget = new ModelBudget(store, { anthropic: 3 * usd, openai: usd })
  const wire = createFetchWire({ credentials: keys, origins: { [provider]: server.origin }, providers: ['openai', 'anthropic'] })
  const ref = await conversation()
  const id = randomUUID()
  await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection(provider), wire)).runTurn(ref, id)
  return { server, ref, id, attempt: await budget.getAttempt(id) }
}
const openaiDone = [
  { type: 'response.output_text.delta', delta: 'ok' },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } } } },
]

test('reservation_is_reconciled_with_the_usage_the_provider_reports_over_real_http', async () => {
  const { server, attempt } = await run('openai', (_request, { res }) => sendEvents(res, openaiDone))
  expect(server.requests).toHaveLength(1)
  // 4 input and 2 output tokens at the short-context floor: far below the context-window reservation.
  expect(attempt).toMatchObject({ state: 'settled', usage: { inputTokens: 4, outputTokens: 2 }, costMicros: 2 })
  expect(attempt!.maxCost).toBeGreaterThan(100_000)
})

test('an_interrupted_stream_keeps_the_whole_reservation_and_is_never_resent', async () => {
  const { server, attempt } = await run('anthropic', (_request, { res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(eventStream([{ type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } }]))
    res.destroy()
  })
  expect(server.requests).toHaveLength(1)
  expect(attempt).toMatchObject({ state: 'reserved' })
  expect(attempt!.maxCost).toBeGreaterThan(1_000_000)
})

test.each([429, 500, 529])('HTTP %i keeps the reservation and sends exactly one request', async status => {
  const { server, attempt } = await run('anthropic', (_request, { res }) => { res.writeHead(status).end('{}') })
  expect(server.requests).toHaveLength(1)
  expect(attempt).toMatchObject({ state: 'reserved' })
})

test('a_rejected_key_settles_at_zero_without_a_second_request', async () => {
  const { server, attempt } = await run('openai', (_request, { res }) => { res.writeHead(401).end('{}') })
  expect(server.requests).toHaveLength(1)
  expect(attempt).toMatchObject({ state: 'settled', costMicros: 0 })
})

test('an_unavailable_credential_never_reaches_the_network_and_costs_nothing', async () => {
  const server = await startProviderServer((_request, { res }) => sendEvents(res, openaiDone))
  servers.push(server)
  budget = new ModelBudget(store, { openai: usd })
  const wire = createFetchWire({ credentials: { get: async () => { throw new Error('boom') }, invalidate: () => undefined },
    origins: { openai: server.origin } })
  const ref = await conversation()
  const id = randomUUID()
  await createGenerationWorker(store, createCatalogTurnProvider(store, budget, () => selection('openai'), wire)).runTurn(ref, id)
  expect(server.requests).toHaveLength(0)
  expect(await budget.getAttempt(id)).toMatchObject({ state: 'settled', costMicros: 0 })
})

test('the_provider_key_never_reaches_the_ledger_or_the_turn', async () => {
  const { ref, id } = await run('openai', (_request, { res }) => sendEvents(res, openaiDone))
  const dump = JSON.stringify([await budget.getAttempt(id), await store.getTurn(pk(), ref.turnId)])
  expect(dump).not.toContain('k'.repeat(24))
})
