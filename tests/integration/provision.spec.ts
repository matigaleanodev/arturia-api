// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest'
import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { PILOT_SCOPE_ACTIONS, PILOT_SCOPE_IDS, applyProvision, readProvision } from '../../src/admin/provision.js'
import { runProvision } from '../../src/admin/cli.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import { createLambdaAdapter, type RestEvent } from '../../src/http/lambda-adapter.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { SimulatedProvider } from '../../src/models/simulated.js'
import { createLog } from '../../src/observability/log.js'
import { integrationDatabase, localDynamoClient } from '../support/dynamodb.js'
import { TestQueue } from '../support/test-queue.js'

const clientId = 'fixtureclient0123456789abcd'
const ORIGIN = 'https://d111111abcdef8.cloudfront.net'
let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let arn: { account: string; region: string }

const now = () => Math.floor(Date.now() / 1_000)
const rows = async (pk: string, prefix?: string) => (await store.db.send(new QueryCommand({
  TableName: store.tableName, ConsistentRead: true,
  KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
  ExpressionAttributeValues: { ':pk': pk, ...(prefix && { ':p': prefix }) },
}))).Items ?? []
const put = (Item: Record<string, unknown>) => store.db.send(new PutCommand({ TableName: store.tableName, Item }))

function cli(argv: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = []
  const created: DynamoDBClient[] = []
  const deps = {
    createClient: () => {
      const client = localDynamoClient(inject('integrationDatabase').endpoint)
      created.push(client)
      return client
    },
    now,
    out: (line: string) => out.push(line),
  }
  return runProvision(argv, env, deps).then(code => ({ code, out: out.join('\n'), created }))
}
const target = () => ['--table', store.tableName, '--region', arn.region, '--profile', 'fixture-profile',
  '--expected-account', arn.account]

beforeEach(async () => {
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName)
  const { Table } = await local.client.send(new DescribeTableCommand({ TableName: local.tableName }))
  const [, , , region, account] = Table!.TableArn!.split(':')
  arn = { account: account!, region: region! }
})
afterEach(() => local.client.destroy())

describe('provision core', () => {
  test('provision_is_idempotent', async () => {
    const sub = randomUUID()
    const first = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 1_000 })
    expect(first.status).toBe('complete')
    expect(first.written).toEqual(['SUBJECT', 'ACCOUNT', 'SCOPE#personal', 'SCOPE#work'])
    const second = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 2_000 })
    expect(second).toMatchObject({ status: 'complete', userId: first.userId, written: [] })
    // A repeated run never moves mfaVerifiedAt, which would invalidate the sessions already accepted.
    expect((await store.read(JSON.stringify([first.userId]), 'ACCOUNT'))).toMatchObject({ status: 'active', mfaVerifiedAt: 1_000 })
    for (const scopeId of PILOT_SCOPE_IDS) {
      expect(await store.getScopeActions(first.userId!, scopeId)).toEqual(expect.arrayContaining([...PILOT_SCOPE_ACTIONS]))
    }
    expect(await store.findUserIdBySubject(sub)).toBe(first.userId)
  })

  test('partial_state_is_completed_reusing_user_and_account', async () => {
    const sub = randomUUID()
    const userId = randomUUID()
    await put({ pk: 'SUBJECT', sk: sub, userId })
    await put({ pk: JSON.stringify([userId]), sk: 'ACCOUNT', status: 'active', mfaVerifiedAt: 500 })
    await put({ pk: scopePartition(userId, 'personal'), sk: 'SCOPE', actions: new Set(PILOT_SCOPE_ACTIONS) })
    expect((await readProvision(store.db, store.tableName, sub)).status).toBe('partial')
    const result = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 9_999 })
    expect(result).toMatchObject({ status: 'complete', userId, written: ['SCOPE#work'] })
    expect(await store.read(JSON.stringify([userId]), 'ACCOUNT')).toMatchObject({ mfaVerifiedAt: 500 })
  })

  test('conflicting_state_is_reported_and_writes_nothing', async () => {
    const disabled = { sub: randomUUID(), userId: randomUUID() }
    await put({ pk: 'SUBJECT', sk: disabled.sub, userId: disabled.userId })
    await put({ pk: JSON.stringify([disabled.userId]), sk: 'ACCOUNT', status: 'disabled' })
    await expect(applyProvision(store.db, store.tableName, disabled.sub, { mfaVerifiedAt: 1 })).rejects.toThrow(/ACCOUNT/)
    expect(await rows(scopePartition(disabled.userId, 'personal'))).toEqual([])
    expect(await store.read(JSON.stringify([disabled.userId]), 'ACCOUNT')).toMatchObject({ status: 'disabled' })

    const narrowed = { sub: randomUUID(), userId: randomUUID() }
    await put({ pk: 'SUBJECT', sk: narrowed.sub, userId: narrowed.userId })
    await put({ pk: scopePartition(narrowed.userId, 'work'), sk: 'SCOPE', actions: new Set(['conversation:read']) })
    const report = await readProvision(store.db, store.tableName, narrowed.sub)
    expect(report.status).toBe('conflict')
    expect(report.items).toContainEqual(expect.objectContaining({ key: 'SCOPE#work', state: 'conflict' }))
    await expect(applyProvision(store.db, store.tableName, narrowed.sub, { mfaVerifiedAt: 1 })).rejects.toThrow(/SCOPE#work/)
    expect(await store.read(JSON.stringify([narrowed.userId]), 'ACCOUNT')).toBeUndefined()
    expect(await store.getScopeActions(narrowed.userId, 'work')).toEqual(['conversation:read'])
  })

  test('concurrent_runs_converge_on_one_user', async () => {
    const sub = randomUUID()
    const results = await Promise.all([1, 2, 3].map(() => applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 7 })))
    const userIds = new Set(results.map(r => r.userId))
    expect(userIds.size).toBe(1)
    expect(results.every(r => r.status === 'complete')).toBe(true)
    expect(results.flatMap(r => r.written).filter(key => key === 'SUBJECT')).toHaveLength(1)
  })

  test('model_grants_absent_by_default', async () => {
    const { userId } = await applyProvision(store.db, store.tableName, randomUUID(), { mfaVerifiedAt: 1 })
    for (const scopeId of PILOT_SCOPE_IDS) expect(await rows(scopePartition(userId!, scopeId), 'MODEL')).toEqual([])
    // A grant written by other means is reported, never hidden.
    const sub = randomUUID()
    const granted = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 1 })
    await put({ pk: scopePartition(granted.userId!, 'work'), sk: 'MODEL#openai', enabled: true })
    expect(await readProvision(store.db, store.tableName, sub)).toMatchObject({ status: 'complete', modelGrants: 'present' })
    const reported = await cli(['--sub', randomUUID(), '--model-grants'])
    expect(reported.code).toBe(1)
    expect(reported.out).toMatch(/13\.14/)
    expect(reported.created).toHaveLength(0)
  })

  test('rejects_subjects_that_are_not_cognito_uuids', async () => {
    for (const sub of ['', 'fixture-sub-1', 'ABC', randomUUID().toUpperCase() + 'x']) {
      await expect(applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 1 })).rejects.toThrow(/sub/)
    }
  })
})

describe('provision CLI', () => {
  test('dry_run_writes_nothing', async () => {
    const sub = randomUUID()
    const result = await cli(['--sub', sub, ...target()])
    expect(result.code).toBe(0)
    expect(result.created).toHaveLength(0)
    expect(JSON.parse(result.out)).toMatchObject({ mode: 'dry-run' })
    expect(result.out).not.toContain(sub)
    expect(await store.findUserIdBySubject(sub)).toBeUndefined()
  })

  test('apply_requires_explicit_target_and_account', async () => {
    const sub = randomUUID()
    const full = target()
    for (const flag of ['--table', '--region', '--profile', '--expected-account']) {
      const i = full.indexOf(flag)
      const argv = ['--sub', sub, '--apply', '--confirm-totp-enrolled', ...full.slice(0, i), ...full.slice(i + 2)]
      const result = await cli(argv)
      expect(result.code, flag).toBe(1)
      expect(result.created, flag).toHaveLength(0)
    }
    const unconfirmed = await cli(['--sub', sub, '--apply', ...full])
    expect(unconfirmed.code).toBe(1)
    expect(unconfirmed.out).toMatch(/TOTP/)

    const otherAccount = full.map(v => v === arn.account ? '111111111111' : v)
    const wrong = await cli(['--sub', sub, '--apply', '--confirm-totp-enrolled', ...otherAccount])
    expect(wrong.code).toBe(1)
    expect(wrong.out).toMatch(/cuenta/)
    const otherRegion = full.map(v => v === arn.region ? 'sa-east-1' : v)
    expect((await cli(['--sub', sub, '--apply', '--confirm-totp-enrolled', ...otherRegion])).code).toBe(1)
    expect(await store.findUserIdBySubject(sub)).toBeUndefined()

    const before = now()
    const applied = await cli(['--sub', sub, '--apply', '--confirm-totp-enrolled', ...full])
    const after = now()
    expect(applied.code).toBe(0)
    expect(JSON.parse(applied.out)).toMatchObject({ mode: 'apply', status: 'complete' })
    expect(applied.out).not.toContain(sub)
    const userId = await store.findUserIdBySubject(sub)
    expect(userId).toBeTruthy()
    // A safety margin covers a local clock behind AWS: earlier sign-ins can never satisfy authTime > mfaVerifiedAt.
    const account = await store.read(JSON.stringify([userId]), 'ACCOUNT')
    expect(account?.mfaVerifiedAt).toBeGreaterThanOrEqual(before + 60)
    expect(account?.mfaVerifiedAt).toBeLessThanOrEqual(after + 60)
    const check = await cli(['--sub', sub, '--check', ...full])
    expect(check.code).toBe(0)
    expect(JSON.parse(check.out)).toMatchObject({ mode: 'check', status: 'complete', modelGrants: 'absent' })
  })

  test('check_reports_incomplete_state_with_nonzero_exit', async () => {
    const sub = randomUUID()
    const absent = await cli(['--sub', sub, '--check', ...target()])
    expect(absent.code).toBe(2)
    expect(JSON.parse(absent.out)).toMatchObject({ status: 'absent' })
    expect(await store.findUserIdBySubject(sub)).toBeUndefined()
  })

  test('refuses_synthetic_identity_and_endpoint_overrides', async () => {
    const argv = ['--sub', randomUUID(), '--apply', '--confirm-totp-enrolled', ...target()]
    for (const env of [{ ARTURIA_IDENTITY_MODE: 'fixture' }, { ARTURIA_IDENTITY_MODE: 'synthetic' },
      { AWS_ENDPOINT_URL: 'http://127.0.0.1:1' }, { AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:1' }]) {
      const result = await cli(argv, env)
      expect(result.code, JSON.stringify(env)).toBe(1)
      expect(result.created).toHaveLength(0)
    }
    expect((await cli(['--sub', randomUUID()], { ARTURIA_IDENTITY_MODE: 'fixture' })).code).toBe(1)
  })

  test('rejects_unknown_or_conflicting_modes', async () => {
    expect((await cli(['--sub', randomUUID(), '--apply', '--check', ...target()])).code).toBe(1)
    expect((await cli(['--sub', randomUUID(), '--unknown'])).code).toBe(1)
    expect((await cli([])).code).toBe(1)
  })
})

describe('provisioned users through the deployable handlers', () => {
  const claims = (sub: string, sessionId: string) => ({
    client_id: clientId, token_use: 'access', scope: 'openid arturia/access', sub,
    origin_jti: sessionId, auth_time: String(now() - 30), exp: String(now() + 300),
  })
  const event = (httpMethod: string, resource: string, pathParameters: Record<string, string>,
    c: Record<string, unknown>, extra: { body?: unknown; headers?: Record<string, string> } = {}): RestEvent => ({
    httpMethod, resource: '/v1/scopes/{scopeId}' + resource, pathParameters, headers: extra.headers ?? {},
    multiValueHeaders: null, body: extra.body === undefined ? null : JSON.stringify(extra.body), isBase64Encoded: false,
    requestContext: { requestId: randomUUID(), authorizer: { claims: c } },
  })
  const adapter = () => createLambdaAdapter({ chat: createChat(store), identity: store, clientId, allowedOrigin: ORIGIN,
    log: createLog(() => {}) })
  const parse = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>

  async function provisionUser() {
    const sub = randomUUID()
    // TOTP verified well before the sign-in that issues the token.
    const { userId } = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: now() - 3_600 })
    return { sub, userId: userId!, claims: claims(sub, 'fixture-family-' + randomUUID()) }
  }

  test('provisioned_user_completes_a_turn', async () => {
    const user = await provisionUser()
    const handle = adapter()
    const created = await handle(event('POST', '/conversations', { scopeId: 'work' }, user.claims, { body: {} }))
    expect(created.statusCode).toBe(201)
    const conversationId = parse(created).conversationId as string
    const accepted = await handle(event('POST', '/conversations/{conversationId}/turns', { scopeId: 'work', conversationId },
      user.claims, { body: { text: 'Entrada sintética' }, headers: { 'Idempotency-Key': randomUUID() } }))
    expect(accepted.statusCode).toBe(202)
    const ref = { userId: user.userId, scopeId: 'work', turnId: parse(accepted).turnId as string }
    const queue = new TestQueue()
    await publishOutbox(store, queue, ref)
    const delivered = queue.take()!
    expect(await createGenerationWorker(store, new SimulatedProvider()).runTurn(delivered, randomUUID())).toBe('done')
    expect(await store.read(turnKey(ref).pk, turnKey(ref).sk)).toMatchObject({ status: 'completed', lastSeq: 2 })
  })

  test('second_user_cannot_read_first_scope', async () => {
    const a = await provisionUser()
    const b = await provisionUser()
    expect(b.userId).not.toBe(a.userId)
    const handle = adapter()
    const created = await handle(event('POST', '/conversations', { scopeId: 'personal' }, a.claims, { body: {} }))
    const conversationId = parse(created).conversationId as string
    const read = await handle(event('GET', '/conversations/{conversationId}', { scopeId: 'personal', conversationId }, b.claims))
    expect([403, 404]).toContain(read.statusCode)
    const listed = await handle(event('GET', '/conversations', { scopeId: 'personal' }, b.claims))
    expect(listed.statusCode).toBe(200)
    expect(parse(listed).conversations).toEqual([])
    // Same user, other scope: the work partition does not expose the personal conversation.
    const crossScope = await handle(event('GET', '/conversations/{conversationId}', { scopeId: 'work', conversationId }, a.claims))
    expect([403, 404]).toContain(crossScope.statusCode)
    // A scope that was never provisioned is denied, not created implicitly.
    const unknown = await handle(event('GET', '/conversations', { scopeId: 'shared' }, a.claims))
    expect(unknown.statusCode).toBe(403)
  })
})
