// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createWorkerHandler } from '../../src/chat/generate.lambda.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import { createLambdaAdapter, type RestEvent } from '../../src/http/lambda-adapter.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { FIXTURE_BLOCKS, pilotFixture } from '../../src/models/fixture-provider.js'
import { createLog } from '../../src/observability/log.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { TestQueue } from '../support/test-queue.js'

const clientId = 'fixtureclient0123456789abcd'
const personal = 'fixture-personal'
const work = 'fixture-work'
const secret = 'TEXTO-PRIVADO-DEL-USUARIO-7f3a'
const actions = new Set(['conversation:list', 'conversation:create', 'conversation:read',
  'turn:create', 'turn:read', 'turn:run', 'turn:cancel', 'turn:stream'])
let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let lines: string[]
let users: { a: User; b: User }
interface User { userId: string; sub: string; sessionId: string }

const now = () => Math.floor(Date.now() / 1_000)
const claimsFor = (user: User, overrides: Record<string, unknown> = {}) => ({
  client_id: clientId, token_use: 'access', scope: 'openid arturia/access', sub: user.sub,
  origin_jti: user.sessionId, auth_time: String(now() - 30), exp: String(now() + 300), ...overrides,
})
function event(httpMethod: string, resource: string, pathParameters: Record<string, string>, options: {
  claims?: Record<string, unknown>; body?: unknown; raw?: string; headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>; requestId?: string
} = {}): RestEvent {
  return {
    httpMethod, resource: '/v1/scopes/{scopeId}' + resource, pathParameters,
    headers: options.headers ?? {}, multiValueHeaders: options.multiValueHeaders ?? null,
    body: options.raw ?? (options.body === undefined ? null : JSON.stringify(options.body)), isBase64Encoded: false,
    requestContext: { requestId: options.requestId ?? randomUUID(), authorizer: options.claims ? { claims: options.claims } : null },
  }
}
const adapter = (target = store) => createLambdaAdapter({ chat: createChat(target), identity: target, clientId,
  log: createLog(line => lines.push(line)) })
const parse = (result: { body: string }) => JSON.parse(result.body) as Record<string, unknown>

async function provision(user: User, scopes: string[]) {
  const items = [
    { pk: 'SUBJECT', sk: user.sub, userId: user.userId },
    { pk: JSON.stringify([user.userId]), sk: 'ACCOUNT', status: 'active', mfaVerifiedAt: now() - 3_600 },
    ...scopes.map(scope => ({ pk: scopePartition(user.userId, scope), sk: 'SCOPE', actions })),
  ]
  for (const Item of items) await store.db.send(new PutCommand({ TableName: store.tableName, Item }))
}
const newUser = (): User => ({ userId: randomUUID(), sub: 'fixture-sub-' + randomUUID(), sessionId: 'fixture-family-' + randomUUID() })

beforeEach(async () => {
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName)
  lines = []
  users = { a: newUser(), b: newUser() }
  await provision(users.a, [personal, work])
  await provision(users.b, [personal])
})
afterEach(() => local.client.destroy())

async function acceptTurn(handle = adapter(), user = users.a, scopeId = personal, text = secret) {
  const created = await handle(event('POST', '/conversations', { scopeId }, { claims: claimsFor(user), body: {} }))
  expect(created.statusCode).toBe(201)
  const conversationId = parse(created).conversationId as string
  const accepted = await handle(event('POST', '/conversations/{conversationId}/turns', { scopeId, conversationId },
    { claims: claimsFor(user), body: { text }, headers: { 'Idempotency-Key': 'fixture-key' } }))
  expect(accepted.statusCode).toBe(202)
  return { conversationId, turnId: parse(accepted).turnId as string }
}

test('http_handler_maps_contract_status_and_errors', async () => {
  const handle = adapter()
  const claims = claimsFor(users.a)
  const expectError = (result: Awaited<ReturnType<typeof handle>>, status: number, code: string, requestId: string) => {
    expect(result.statusCode).toBe(status)
    expect(result.headers).toEqual({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    expect(parse(result)).toEqual({ code, message: expect.any(String), requestId })
  }
  const { conversationId, turnId } = await acceptTurn(handle)

  const list = await handle(event('GET', '/conversations', { scopeId: personal }, { claims }))
  expect(list.statusCode).toBe(200)
  expect((parse(list).conversations as unknown[]).length).toBe(1)
  expect((await handle(event('GET', '/conversations/{conversationId}', { scopeId: personal, conversationId }, { claims }))).statusCode).toBe(200)
  const turn = await handle(event('GET', '/turns/{turnId}', { scopeId: personal, turnId }, { claims }))
  expect(turn.statusCode).toBe(200)
  expect(parse(turn)).toMatchObject({ turnId, status: 'queued' })
  const replay = await handle(event('POST', '/conversations/{conversationId}/turns', { scopeId: personal, conversationId },
    { claims, body: { text: secret }, headers: { 'idempotency-key': 'fixture-key' } }))
  expect([replay.statusCode, parse(replay).turnId]).toEqual([202, turnId])

  const cases: [RestEvent, number, string][] = [
    [event('POST', '/conversations/{conversationId}/turns', { scopeId: personal, conversationId },
      { claims, body: { text: 'otro' }, headers: { 'Idempotency-Key': 'fixture-key' } }), 409, 'IDEMPOTENCY_CONFLICT'],
    [event('POST', '/conversations/{conversationId}/turns', { scopeId: personal, conversationId }, { claims, body: { text: 'x' } }), 400, 'INVALID_REQUEST'],
    [event('POST', '/conversations/{conversationId}/turns', { scopeId: personal, conversationId }, { claims, body: { text: 'x' },
      multiValueHeaders: { 'Idempotency-Key': ['uno', 'dos'] } }), 400, 'INVALID_REQUEST'],
    [event('POST', '/conversations', { scopeId: personal }, { claims, raw: '{"title":' }), 400, 'INVALID_REQUEST'],
    [event('POST', '/conversations', { scopeId: personal }, { claims, body: [] }), 400, 'INVALID_REQUEST'],
    [event('GET', '/turns/{turnId}', { scopeId: personal, turnId: 'missing-turn' }, { claims }), 404, 'NOT_FOUND'],
    [event('GET', '/turns/{turnId}', { scopeId: 'fixture-foreign', turnId }, { claims }), 403, 'PERMISSION_REVOKED'],
    [event('GET', '/turns/{turnId}', { scopeId: work, turnId }, { claims }), 404, 'NOT_FOUND'],
    [event('GET', '/turns/{turnId}', { scopeId: personal, turnId }, {}), 401, 'UNAUTHENTICATED'],
    [event('GET', '/turns/{turnId}', { scopeId: personal, turnId }, { claims: { ...claims, exp: String(now() - 1) } }), 401, 'UNAUTHENTICATED'],
    [event('DELETE', '/turns/{turnId}', { scopeId: personal, turnId }, { claims }), 404, 'NOT_FOUND'],
    [{ ...event('GET', '/turns/{turnId}', { scopeId: personal, turnId }, { claims }), resource: '/v1/other' }, 404, 'NOT_FOUND'],
  ]
  for (const [request, status, code] of cases) expectError(await handle(request), status, code, request.requestContext.requestId)

  const encoded = event('POST', '/conversations', { scopeId: personal }, { claims })
  const created = await handle({ ...encoded, body: Buffer.from('{"title":"Base64"}').toString('base64'), isBase64Encoded: true })
  expect([created.statusCode, parse(created).title]).toEqual([201, 'Base64'])
  const cancelled = await handle(event('POST', '/turns/{turnId}/cancel', { scopeId: personal, turnId }, { claims }))
  expect([cancelled.statusCode, parse(cancelled).status]).toEqual([200, 'cancelled'])

  // Infrastructure failures keep the public shape and never leak the cause.
  const broken = new ChatStore(new DynamoDBClient({ endpoint: inject('integrationDatabase').endpoint, region: 'us-east-1', maxAttempts: 1,
    credentials: { accessKeyId: 'ArturiaLocal', secretAccessKey: 'synthetic-local-only' } }), 'arturia-missing-table')
  const failed = event('GET', '/conversations', { scopeId: personal }, { claims })
  expectError(await adapter(broken)(failed), 500, 'INTERNAL_ERROR', failed.requestContext.requestId)
  expect(lines.some(line => JSON.parse(line).errorType === 'ResourceNotFoundException')).toBe(true)
})

test('actor_never_taken_from_body', async () => {
  const handle = adapter()
  const { conversationId, turnId } = await acceptTurn(handle)
  const impersonation = { userId: users.b.userId, sessionId: users.b.sessionId, sub: users.b.sub }
  // No verified claims: body, query and headers cannot establish an actor.
  for (const request of [
    event('POST', '/conversations', { scopeId: personal }, { body: { title: 't', ...impersonation } }),
    event('POST', '/conversations', { scopeId: personal }, { body: {}, headers: { Authorization: 'Bearer a.b.c', 'X-User-Id': users.a.userId } }),
    { ...event('GET', '/conversations', { scopeId: personal }), queryStringParameters: impersonation },
  ]) expect((await handle(request)).statusCode).toBe(401)
  // Claims from another app client, an ID token or without the Arturia scope are rejected.
  for (const claims of [claimsFor(users.a, { client_id: 'otherclient' }), claimsFor(users.a, { token_use: 'id' }),
    claimsFor(users.a, { scope: 'openid' }), claimsFor(users.a, { sub: 'fixture-unknown-subject' })]) {
    expect((await handle(event('GET', '/conversations', { scopeId: personal }, { claims }))).statusCode).toBe(401)
  }
  // A's verified identity with B's identifiers in the body is rejected, never applied.
  const forged = await handle(event('POST', '/conversations/{conversationId}/turns', { scopeId: personal, conversationId },
    { claims: claimsFor(users.a), body: { text: 'x', ...impersonation }, headers: { 'Idempotency-Key': 'forged' } }))
  expect(forged.statusCode).toBe(400)
  // B's own identity cannot read A's turn even in a scope with the same name.
  const foreign = await handle(event('GET', '/turns/{turnId}', { scopeId: personal, turnId }, { claims: claimsFor(users.b) }))
  expect(foreign.statusCode).toBe(404)
  const listB = await handle(event('GET', '/conversations', { scopeId: personal }, { claims: claimsFor(users.b) }))
  expect(parse(listB).conversations).toEqual([])
  // A revoked session stays revoked for the HTTP handler.
  await store.db.send(new PutCommand({ TableName: store.tableName, Item: {
    pk: JSON.stringify([users.a.userId]), sk: 'SESSION#' + users.a.sessionId, status: 'revoked' } }))
  expect((await handle(event('GET', '/conversations', { scopeId: personal }, { claims: claimsFor(users.a) }))).statusCode).toBe(401)
})

test('gateway_claims_accept_rest_date_expiration', async () => {
  const handle = adapter()
  const pad = (n: number) => String(n).padStart(2, '0')
  const restDate = (seconds: number) => {
    const d = new Date(seconds * 1_000)
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ` +
      `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ` +
      `${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`
  }
  const list = (exp: unknown) => handle(event('GET', '/conversations', { scopeId: personal }, { claims: claimsFor(users.a, { exp }) }))
  const valid = restDate(now() + 300)
  expect((await list(valid)).statusCode).toBe(200)
  const wrongDay = valid.replace(/^\w{3}/, day => day === 'Mon' ? 'Tue' : 'Mon')
  for (const exp of [restDate(now() - 1), wrongDay, 'Sat Feb 30 10:00:00 UTC 2099', valid.replace(' UTC ', ' GMT '),
    valid + ' ', '1e12', '-5']) {
    expect((await list(exp)).statusCode, exp).toBe(401)
  }
})

test('worker_retry_becomes_batch_item_failure', async () => {
  const record = (messageId: string, body: unknown) => ({ messageId, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const ref = { userId: 'fixture-user', scopeId: personal, turnId: 'fixture-turn' }
  const log = createLog(line => lines.push(line))
  const outcomes: Record<string, () => Promise<'done' | 'retry'>> = {
    'turn-done': async () => 'done', 'turn-retry': async () => 'retry',
    'turn-throws': async () => { throw new Error(secret) },
  }
  const handle = createWorkerHandler({ log, run: async target => outcomes[target.turnId]() })
  expect(await handle({ Records: [record('m1', { ...ref, turnId: 'turn-done' })] })).toEqual({ batchItemFailures: [] })
  expect(await handle({ Records: [record('m1', { ...ref, turnId: 'turn-retry' })] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] })
  expect(await handle({ Records: [record('m1', { ...ref, turnId: 'turn-throws' })] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] })
  for (const body of ['no-json', { ...ref, extra: 1 }, { ...ref, turnId: '' }, [ref]]) {
    expect(await handle({ Records: [record('bad', body)] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] })
  }
  // FIFO order: after a failure the rest of the batch is returned without being processed.
  let ran = 0
  const ordered = createWorkerHandler({ log, run: async target => { ran++; return target.turnId === 'first' ? 'retry' : 'done' } })
  expect(await ordered({ Records: [record('a', { ...ref, turnId: 'first' }), record('b', { ...ref, turnId: 'second' })] }))
    .toEqual({ batchItemFailures: [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }] })
  expect(ran).toBe(1)

  // Real semantics: a live lease held by another delivery is a retry, not a second provider call.
  const { turnId } = await acceptTurn()
  const queue = new TestQueue()
  await publishOutbox(store, queue, { userId: users.a.userId, scopeId: personal, turnId })
  const message = queue.take()!
  // Above the worker's 500 ms flush window, so each block becomes its own sequence.
  const fixture = pilotFixture({ environment: 'pilot', providerMode: 'fixture' }, 600)
  if (fixture.kind !== 'stream') throw new Error('Expected the streaming fixture')
  let calls = 0
  const generation = createGenerationWorker(store, { stream: request => { calls++; return fixture.provider.stream(request) } }, { pollMs: 20 })
  const consume = createWorkerHandler({ log, run: (target, attemptId) => generation.runTurn(target, attemptId) })
  const first = consume({ Records: [record('first', message)] })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(await consume({ Records: [record('second', message)] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'second' }] })
  expect(await first).toEqual({ batchItemFailures: [] })
  expect(await consume({ Records: [record('third', message)] })).toEqual({ batchItemFailures: [] })
  expect(calls).toBe(1)
  const turn = await createChat(store).getTurn({ userId: users.a.userId, sessionId: users.a.sessionId }, personal, turnId)
  expect(turn).toMatchObject({ status: 'completed', lastSeq: 3, result: { text: FIXTURE_BLOCKS.join('') } })
})

test('logs_never_include_message_text', async () => {
  const handle = adapter()
  const { turnId } = await acceptTurn(handle)
  await handle(event('POST', '/conversations', { scopeId: personal }, { claims: claimsFor(users.a), raw: secret }))
  const queue = new TestQueue()
  await publishOutbox(store, queue, { userId: users.a.userId, scopeId: personal, turnId })
  const fixture = pilotFixture({ environment: 'pilot', providerMode: 'fixture' }, 1)
  if (fixture.kind !== 'stream') throw new Error('Expected the streaming fixture')
  const generation = createGenerationWorker(store, fixture.provider, { pollMs: 20 })
  const log = createLog(line => lines.push(line))
  await createWorkerHandler({ log, run: (ref, attemptId) => generation.runTurn(ref, attemptId) })(
    { Records: [{ messageId: 'm1', body: JSON.stringify(queue.take()) }] })
  await createWorkerHandler({ log, run: async () => { throw new Error(secret) } })(
    { Records: [{ messageId: 'm2', body: JSON.stringify({ userId: secret, scopeId: secret, turnId: secret }) }] })
  log('error', 'PROBE', { requestId: secret + ' with spaces', turnId: '<script>', error: Object.assign(new Error(secret), { name: secret + ' x' }) })

  const allowed = new Set(['level', 'code', 'requestId', 'turnId', 'attemptId', 'messageId', 'status', 'errorType', 'variables'])
  expect(lines.length).toBeGreaterThanOrEqual(6)
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>
    for (const key of Object.keys(entry)) expect(allowed.has(key), key).toBe(true)
    for (const forbidden of [secret, ...FIXTURE_BLOCKS, users.a.sub, users.a.sessionId, '<script>']) {
      expect(line.includes(forbidden), line).toBe(false)
    }
  }
})

describe('packaged handlers', () => {
  let outdir: string
  beforeAll(() => {
    outdir = mkdtempSync(join(tmpdir(), 'arturia-handler-bundles-'))
    execFileSync(process.execPath, ['scripts/bundle.mjs', '--outdir', outdir], { stdio: 'pipe', timeout: 60_000 })
  }, 70_000)
  afterAll(() => rmSync(outdir, { recursive: true, force: true }))

  // Loads the bundle in a clean process with simulated AWS services: DynamoDB Local and synthetic credentials.
  function invoke(bundle: 'http' | 'worker', payload: unknown, variables: Record<string, string>) {
    const driver = 'const m=require(process.argv[1]);m.handler(JSON.parse(process.argv[2])).then(' +
      'r=>process.stdout.write("@@RESULT@@"+JSON.stringify(r)+"\\n"),' +
      'e=>{process.stdout.write("@@THROWN@@"+e.message+"\\n");process.exitCode=1})'
    const run = spawnSync(process.execPath, ['-e', driver, join(outdir, bundle, 'index.cjs'), JSON.stringify(payload)], {
      encoding: 'utf8', timeout: 30_000, env: {
        PATH: process.env.PATH ?? '', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_DYNAMODB: inject('integrationDatabase').endpoint,
        AWS_ACCESS_KEY_ID: 'ArturiaLocal', AWS_SECRET_ACCESS_KEY: 'synthetic-local-only', AWS_MAX_ATTEMPTS: '1', ...variables,
      } })
    const output = run.stdout.split('\n')
    const result = output.find(line => line.startsWith('@@RESULT@@'))
    const thrown = output.find(line => line.startsWith('@@THROWN@@'))
    return { result: result && JSON.parse(result.slice(10)), thrown: thrown?.slice(10), logs: output.filter(line => line.startsWith('{')),
      stderr: run.stderr, output: run.stdout }
  }
  const httpEnv = () => ({ ARTURIA_TABLE_NAME: store.tableName, ARTURIA_CLIENT_ID: clientId })
  const workerEnv = (mode: string) => ({ ARTURIA_TABLE_NAME: store.tableName, ARTURIA_ENVIRONMENT: 'pilot', ARTURIA_PROVIDER_MODE: mode })

  test('bundled_http_turn_completes_with_one_bundled_worker_attempt', async () => {
    const claims = claimsFor(users.a)
    const created = invoke('http', event('POST', '/conversations', { scopeId: personal }, { claims, body: {} }), httpEnv())
    expect(created.result?.statusCode, created.stderr).toBe(201)
    const conversationId = JSON.parse(created.result.body).conversationId
    const accepted = invoke('http', event('POST', '/conversations/{conversationId}/turns', { scopeId: personal, conversationId },
      { claims, body: { text: secret }, headers: { 'Idempotency-Key': 'bundle-key' } }), httpEnv())
    expect(accepted.result?.statusCode, accepted.stderr).toBe(202)
    const turnId = JSON.parse(accepted.result.body).turnId as string
    const queue = new TestQueue()
    await publishOutbox(store, queue, { userId: users.a.userId, scopeId: personal, turnId })
    const message = { Records: [{ messageId: 'bundle-1', body: JSON.stringify(queue.take()) }] }

    const started = performance.now()
    const first = invoke('worker', message, workerEnv('fixture'))
    expect(first.result, first.stderr).toEqual({ batchItemFailures: [] })
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_000)
    const row = await store.read(turnKey({ userId: users.a.userId, scopeId: personal, turnId }).pk, 'TURN#' + turnId)
    expect(row).toMatchObject({ status: 'completed', lastSeq: 3, sendState: 'confirmed' })
    // Redelivery acknowledges the terminal turn without a second attempt.
    const second = invoke('worker', { Records: [{ ...message.Records[0], messageId: 'bundle-2' }] }, workerEnv('fixture'))
    expect(second.result).toEqual({ batchItemFailures: [] })
    expect(await store.read(row!.pk, row!.sk)).toEqual(row)
    const snapshot = invoke('http', event('GET', '/turns/{turnId}', { scopeId: personal, turnId }, { claims }), httpEnv())
    expect(JSON.parse(snapshot.result.body)).toMatchObject({ status: 'completed', result: { text: FIXTURE_BLOCKS.join('') } })
    // Logs and stderr, not the HTTP result, must stay free of message and generated text.
    for (const run of [created, accepted, first, second, snapshot]) {
      const diagnostics = run.logs.join('\n') + run.stderr
      expect(run.logs.length).toBeGreaterThan(0)
      for (const text of [secret, ...FIXTURE_BLOCKS, users.a.sub]) expect(diagnostics.includes(text)).toBe(false)
    }
    expect(first.logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      code: 'TURN_DONE', turnId, attemptId: row!.attemptId }))
    expect(accepted.logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ code: 'HTTP_OK', status: 202, turnId }))
  }, 60_000)

  test('bundled_fail_mode_leaves_turn_queued_for_the_dlq', async () => {
    const { turnId } = await acceptTurn()
    const body = JSON.stringify({ userId: users.a.userId, scopeId: personal, turnId })
    const failed = invoke('worker', { Records: [{ messageId: 'fail-1', body }] }, workerEnv('fail'))
    expect(failed.result).toEqual({ batchItemFailures: [{ itemIdentifier: 'fail-1' }] })
    const row = await store.read(scopePartition(users.a.userId, personal), 'TURN#' + turnId)
    expect(row).toMatchObject({ status: 'queued' })
    expect(row?.sendState).toBeUndefined()
  }, 30_000)

  test('bundled_handlers_fail_closed_without_configuration', () => {
    const request = event('GET', '/conversations', { scopeId: personal }, { claims: claimsFor(users.a), requestId: 'fixture-config' })
    const http = invoke('http', request, { ARTURIA_TABLE_NAME: store.tableName, ARTURIA_CLIENT_ID: 'Bearer secret-value!' })
    expect(http.result.statusCode).toBe(500)
    expect(JSON.parse(http.result.body)).toEqual({ code: 'INTERNAL_ERROR', message: expect.any(String), requestId: 'fixture-config' })
    expect(http.logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      code: 'CONFIG_INVALID', variables: ['ARTURIA_CLIENT_ID'] }))
    const message = { Records: [{ messageId: 'cfg-1', body: '{}' }] }
    for (const variables of [{}, workerEnv('catalog'), { ...workerEnv('fixture'), ARTURIA_ENVIRONMENT: 'prod' }]) {
      const worker = invoke('worker', message, variables)
      expect(worker.result).toBeUndefined()
      expect(worker.thrown).toBe('Invalid runtime configuration')
    }
    for (const run of [http]) expect(run.output.includes('secret-value')).toBe(false)
  }, 60_000)
})
