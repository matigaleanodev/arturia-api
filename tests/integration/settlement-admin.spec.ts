// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { CreateTableCommand, DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest'
import { applyProvision } from '../../src/admin/provision.js'
import { runSettle } from '../../src/admin/cli.js'
import { ChatStore } from '../../src/chat/turns.store.js'
import { ModelBudget, type Tariff } from '../../src/models/budget.js'
import { applySettlement, listUncertainReservations, parseEvidence, planSettlement, type Evidence }
  from '../../src/models/settlement-admin.js'
import { integrationDatabase, localDynamoClient } from '../support/dynamodb.js'

const usd = 1_000_000
const provider = 'fixture-a'
const price: Tariff = {
  inputPerMillion: 300_000, outputPerMillion: 1_100_000, toolCall: 23,
  verifiedAt: Date.UTC(2025, 0), expiresAt: Date.UTC(2040, 0),
}
const AGED = 400_000

let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let ledger: ChatStore
let ledgerTable: string
let budget: ModelBudget
let arn: { account: string; region: string }
let time: number
// Counters are global per UTC month and the table is shared with other spec files running in parallel.
let monthIndex = 0
let month: string
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7)

beforeAll(async () => {
  const client = integrationDatabase().client
  ledgerTable = 'ledger-' + randomUUID()
  await client.send(new CreateTableCommand({ TableName: ledgerTable, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }))
  client.destroy()
})

beforeEach(async () => {
  time = Date.UTC(2035, monthIndex++, 1)
  month = monthOf(time)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  ledger = new ChatStore(local.client, ledgerTable, () => new Date(time))
  budget = new ModelBudget(ledger, { [provider]: 6 * usd })
  const { Table } = await local.client.send(new DescribeTableCommand({ TableName: local.tableName }))
  const [, , , region, account] = Table!.TableArn!.split(':')
  arn = { account: account!, region: region! }
})
afterEach(() => local.client.destroy())

async function provisionUser() {
  const sub = randomUUID()
  const { userId } = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 1 })
  return { sub, userId: userId! }
}
type User = Awaited<ReturnType<typeof provisionUser>>
async function reserve(user: User, scopeId = 'personal', maxCost = usd) {
  const attemptId = randomUUID()
  const result = await budget.reserveAttempt(attemptId, user.userId, scopeId, provider, maxCost,
    { model: 'fixture-model', operation: 'chat', tariff: price, turnId: randomUUID() })
  expect(result.allowed).toBe(true)
  return attemptId
}
const age = () => { time += AGED }
const allocated = async (m = month) => (await ledger.read('MODEL-BUDGET#' + m, 'TOTAL'))?.allocated as number | undefined
const evidence = (entries: Array<[string, number]>, m = month): Evidence =>
  ({ month: m, entries: entries.map(([attemptId, costMicros], i) => ({ attemptId, costMicros, reference: 'invoice-line-' + (i + 1) })) })
const idsOf = (rows: ReadonlyArray<{ attemptId: string }>) => rows.map(r => r.attemptId).sort()

describe('lists_only_uncertain_reservations', () => {
  test('only reserved attempts of the month, the user and old enough to be out of flight', async () => {
    const a = await provisionUser()
    const b = await provisionUser()
    const old = await reserve(a, 'personal')
    const settled = await reserve(a, 'work')
    const otherUser = await reserve(b, 'personal')
    await budget.settleAttempt(settled, { kind: 'invoice', costMicros: 10 })
    age()
    const young = await reserve(a, 'personal')
    expect(idsOf(await listUncertainReservations(ledger, month, { userId: a.userId }))).toEqual([old])
    expect(idsOf(await listUncertainReservations(ledger, month, { userId: a.userId, minAgeSeconds: 0 }))).toEqual([old, young].sort())
    expect(idsOf(await listUncertainReservations(ledger, month))).toEqual([old, otherUser].sort())
    expect(await listUncertainReservations(ledger, month, { userId: a.userId, scopeIds: ['work'] })).toEqual([])
    // A reservation of another UTC month never shows up.
    time = Date.UTC(2037, monthIndex, 1)
    await reserve(a)
    time += AGED
    // `young` has aged meanwhile; the reservation of the other month is still absent.
    expect(idsOf(await listUncertainReservations(ledger, month, { userId: a.userId }))).toEqual([old, young].sort())
  })

  test('rows expose accounting fields only', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const [row] = await listUncertainReservations(ledger, month, { userId: a.userId })
    expect(row).toMatchObject({ attemptId: id, scopeId: 'personal', provider, maxCost: usd, month, ageSeconds: AGED / 1000 })
    expect(Object.keys(row!).sort()).toEqual(['ageSeconds', 'attemptId', 'maxCost', 'model', 'month', 'provider', 'reservedAt', 'scopeId', 'turnId'])
  })
})

describe('invoice_settlement_is_idempotent', () => {
  test('settles once, releases only the backed difference and audits without content', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const plan = await planSettlement(ledger, evidence([[id, 400_000]]), { userId: a.userId })
    expect(plan.settle).toEqual([{ attemptId: id, costMicros: 400_000, maxCost: usd, releasedMicros: 600_000, reference: 'invoice-line-1' }])
    expect(await applySettlement(ledger, plan)).toEqual({ settled: 1, alreadySettled: 0 })
    expect(await budget.getAttempt(id)).toMatchObject({ state: 'settled', costMicros: 400_000 })
    expect(await allocated()).toBe(400_000)
    const audit = await ledger.read('MODEL-SETTLEMENT#' + id, 'AUDIT')
    expect(Object.keys(audit!).sort()).toEqual(['attemptId', 'costMicros', 'maxCost', 'month', 'pk', 'provider', 'reference', 'scopeId',
      'settledAt', 'sk', 'source', 'turnId'])
    expect(audit).toMatchObject({ reference: 'invoice-line-1', source: 'operator-cli', costMicros: 400_000, maxCost: usd })

    // Same evidence again: nothing to do, nothing written.
    const again = await planSettlement(ledger, evidence([[id, 400_000]]), { userId: a.userId })
    expect(again.settle).toEqual([])
    expect(again.alreadySettled).toEqual([id])
    expect(await applySettlement(ledger, again)).toEqual({ settled: 0, alreadySettled: 1 })
    expect(await allocated()).toBe(400_000)
    // Different evidence for a settled attempt is a conflict, never an overwrite.
    const conflict = await planSettlement(ledger, evidence([[id, 100_000]]), { userId: a.userId })
    expect(conflict.rejected).toEqual([{ attemptId: id, reason: 'conflicting-settlement' }])
    expect(await allocated()).toBe(400_000)
  })

  test('concurrent applications of one plan settle once', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const plan = await planSettlement(ledger, evidence([[id, 250_000]]), { userId: a.userId })
    const results = await Promise.all([applySettlement(ledger, plan), applySettlement(ledger, plan), applySettlement(ledger, plan)])
    expect(results.reduce((n, r) => n + r.settled + r.alreadySettled, 0)).toBe(3)
    expect(await allocated()).toBe(250_000)
    const { Items } = await ledger.db.send(new QueryCommand({ TableName: ledger.tableName, ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'MODEL-SETTLEMENT#' + id } }))
    expect(Items).toHaveLength(1)
  })

  test('an invoice above the reservation is recorded as the real, higher spend', async () => {
    const a = await provisionUser()
    const id = await reserve(a, 'personal', 100_000)
    age()
    const plan = await planSettlement(ledger, evidence([[id, 130_000]]), { userId: a.userId })
    expect(plan.settle[0]).toMatchObject({ costMicros: 130_000, releasedMicros: -30_000 })
    await applySettlement(ledger, plan)
    expect(await allocated()).toBe(130_000)
  })
})

describe('missing_evidence_keeps_reservation', () => {
  test('attempts without an evidence entry stay reserved and keep their counters', async () => {
    const a = await provisionUser()
    const [covered, missing] = [await reserve(a, 'personal', usd), await reserve(a, 'work', 2 * usd)]
    age()
    const plan = await planSettlement(ledger, evidence([[covered, 300_000]]), { userId: a.userId })
    expect(plan.kept).toEqual([missing])
    await applySettlement(ledger, plan)
    expect(await budget.getAttempt(missing)).toMatchObject({ state: 'reserved' })
    expect(await allocated()).toBe(300_000 + 2 * usd)
  })

  test('empty evidence writes nothing', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const plan = await planSettlement(ledger, evidence([]), { userId: a.userId })
    expect(plan).toMatchObject({ settle: [], kept: [id], rejected: [] })
    expect(await applySettlement(ledger, plan)).toEqual({ settled: 0, alreadySettled: 0 })
    expect(await allocated()).toBe(usd)
  })

  test('a reservation that is too recent to be out of flight is never settled', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    const plan = await planSettlement(ledger, evidence([[id, 1]]), { userId: a.userId })
    expect(plan.settle).toEqual([])
    expect(plan.rejected).toEqual([{ attemptId: id, reason: 'too-recent' }])
  })
})

describe('settlement_never_crosses_months', () => {
  test('evidence for another month is rejected and both months stay untouched', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const other = monthOf(Date.UTC(2037, monthIndex + 1, 1))
    const plan = await planSettlement(ledger, evidence([[id, 1]], other), { userId: a.userId })
    expect(plan.rejected).toEqual([{ attemptId: id, reason: 'month-mismatch' }])
    expect(plan.settle).toEqual([])
    await applySettlement(ledger, plan)
    expect(await budget.getAttempt(id)).toMatchObject({ state: 'reserved', month })
    expect(await allocated()).toBe(usd)
    expect(await allocated(other)).toBeUndefined()
  })

  test('the settlement lands in the original month even when applied later', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const plan = await planSettlement(ledger, evidence([[id, 1]]), { userId: a.userId })
    time = Date.UTC(2036, 5, 1)
    await applySettlement(ledger, plan)
    expect(await allocated()).toBe(1)
    expect(await allocated(monthOf(time))).toBeUndefined()
  })
})

describe('settlement_is_isolated_by_user_and_scope', () => {
  test('an operator for one user cannot settle or even probe another user attempt', async () => {
    const a = await provisionUser()
    const b = await provisionUser()
    const ofA = await reserve(a)
    age()
    const plan = await planSettlement(ledger, evidence([[ofA, 1]]), { userId: b.userId })
    expect(plan.rejected).toEqual([{ attemptId: ofA, reason: 'unknown-attempt' }])
    expect(plan.kept).toEqual([])
    await applySettlement(ledger, plan)
    expect(await budget.getAttempt(ofA)).toMatchObject({ state: 'reserved' })
  })

  test('a scope filter excludes the other scope', async () => {
    const a = await provisionUser()
    const personal = await reserve(a, 'personal')
    const work = await reserve(a, 'work')
    age()
    const plan = await planSettlement(ledger, evidence([[personal, 1], [work, 1]]), { userId: a.userId, scopeIds: ['personal'] })
    expect(plan.settle.map(s => s.attemptId)).toEqual([personal])
    expect(plan.rejected).toEqual([{ attemptId: work, reason: 'unknown-attempt' }])
  })

  test('an unknown attempt is rejected', async () => {
    const a = await provisionUser()
    const plan = await planSettlement(ledger, evidence([[randomUUID(), 1]]), { userId: a.userId })
    expect(plan.rejected).toMatchObject([{ reason: 'unknown-attempt' }])
  })
})

describe('evidence validation', () => {
  const good = { month: '2035-01', entries: [{ attemptId: randomUUID(), costMicros: 10, reference: 'inv-1' }] }
  test('accepts a well formed file', () => { expect(parseEvidence(good)).toEqual(good) })
  test.each([
    ['not an object', 'x'], ['array', []], ['bad month', { ...good, month: '2035-13' }], ['missing entries', { month: '2035-01' }],
    ['unknown key', { ...good, content: 'x' }],
    ['unknown entry key', { ...good, entries: [{ ...good.entries[0], text: 'x' }] }],
    ['negative cost', { ...good, entries: [{ ...good.entries[0], costMicros: -1 }] }],
    ['fractional cost', { ...good, entries: [{ ...good.entries[0], costMicros: 1.5 }] }],
    ['unsafe cost', { ...good, entries: [{ ...good.entries[0], costMicros: 2 ** 60 }] }],
    ['bad reference', { ...good, entries: [{ ...good.entries[0], reference: 'has space' }] }],
    ['long reference', { ...good, entries: [{ ...good.entries[0], reference: 'a'.repeat(65) }] }],
    ['bad attempt id', { ...good, entries: [{ ...good.entries[0], attemptId: 'x' }] }],
    ['duplicate attempt', { ...good, entries: [good.entries[0], { ...good.entries[0], reference: 'inv-2' }] }],
    ['too many entries', { ...good, entries: Array.from({ length: 1001 }, () => ({ attemptId: randomUUID(), costMicros: 1, reference: 'r' })) }],
  ])('rejects %s', (_name, input) => { expect(() => parseEvidence(input)).toThrow() })
})

describe('settle CLI', () => {
  const target = () => ['--table', store.tableName, '--ledger-table', ledger.tableName, '--region', arn.region, '--profile', 'fixture-profile', '--expected-account', arn.account]
  function cli(argv: string[], file: unknown = undefined, env: Record<string, string | undefined> = {}) {
    const out: string[] = []
    const created: DynamoDBClient[] = []
    const reads: string[] = []
    return runSettle(argv, env, {
      createClient: () => { const c = localDynamoClient(inject('integrationDatabase').endpoint); created.push(c); return c },
      now: () => time,
      readEvidence: async path => { reads.push(path); if (file instanceof Error) throw file; return file },
      out: line => out.push(line),
    }).then(code => ({ code, out: out.join('\n'), created, reads }))
  }
  const snapshot = async (id: string) => ({ attempt: await budget.getAttempt(id), total: await allocated(),
    audit: await ledger.read('MODEL-SETTLEMENT#' + id, 'AUDIT') })

  test('lists uncertain reservations without writing and without exposing the subject', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const result = await cli(['--sub', a.sub, '--month', month, ...target()])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toMatchObject({ mode: 'list', month, count: 1, reservedMicros: usd, attempts: [{ attemptId: id }] })
    expect(result.out).not.toContain(a.sub)
    expect(result.out).not.toContain(a.userId)
    expect(result.reads).toEqual([])
  })

  test('dry_run_writes_nothing', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const before = await snapshot(id)
    const result = await cli(['--sub', a.sub, '--month', month, '--evidence', 'evidence.json', ...target()], evidence([[id, 100_000]]))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toMatchObject({ mode: 'dry-run', settle: [{ attemptId: id, costMicros: 100_000, releasedMicros: 900_000 }], kept: [] })
    expect(await snapshot(id)).toEqual(before)
  })

  test('apply settles, reports and is repeatable', async () => {
    const a = await provisionUser()
    const [one, two] = [await reserve(a), await reserve(a, 'work')]
    age()
    const argv = ['--sub', a.sub, '--month', month, '--evidence', 'evidence.json', '--apply', ...target()]
    const first = await cli(argv, evidence([[one, 100_000]]))
    expect(first.code).toBe(0)
    expect(JSON.parse(first.out)).toMatchObject({ mode: 'apply', settled: 1, alreadySettled: 0, kept: [two] })
    expect(await allocated()).toBe(100_000 + usd)
    const again = await cli(argv, evidence([[one, 100_000]]))
    expect(JSON.parse(again.out)).toMatchObject({ mode: 'apply', settled: 0, alreadySettled: 1 })
    expect(await allocated()).toBe(100_000 + usd)
  })

  test('a rejected entry exits with 2 and still applies the valid ones', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const result = await cli(['--sub', a.sub, '--month', month, '--evidence', 'e.json', '--apply', ...target()],
      evidence([[id, 100_000], [randomUUID(), 5]]))
    expect(result.code).toBe(2)
    expect(JSON.parse(result.out)).toMatchObject({ settled: 1, rejected: [{ reason: 'unknown-attempt' }] })
    expect(await budget.getAttempt(id)).toMatchObject({ state: 'settled' })
  })

  test('--all-users reconciles from the ledger alone: the chat table can be a fresh, empty one', async () => {
    const a = await provisionUser()
    const b = await provisionUser()
    const [one, two] = [await reserve(a), await reserve(b, 'work')]
    age()
    const fresh = ['--ledger-table', ledger.tableName, '--region', arn.region, '--profile', 'fixture-profile', '--expected-account', arn.account]
    const listed = await cli(['--all-users', '--month', month, ...fresh])
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out)).toMatchObject({ mode: 'list', subject: 'all-users', count: 2 })
    const applied = await cli(['--all-users', '--month', month, '--evidence', 'e.json', '--apply', ...fresh], evidence([[one, 100_000]]))
    expect(applied.code).toBe(0)
    expect(JSON.parse(applied.out)).toMatchObject({ mode: 'apply', settled: 1, kept: [two] })
    expect(await budget.getAttempt(one)).toMatchObject({ state: 'settled', costMicros: 100_000 })
    expect(await budget.getAttempt(two)).toMatchObject({ state: 'reserved' })
  })

  test('refuses an ambiguous or unsafe table target', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const before = await snapshot(id)
    const rest = ['--region', arn.region, '--profile', 'fixture-profile', '--expected-account', arn.account, '--month', month]
    const cases: string[][] = [
      ['--sub', a.sub, '--table', store.tableName, ...rest],                                         // no ledger table
      ['--sub', a.sub, '--table', store.tableName, '--ledger-table', store.tableName, ...rest],      // ledger == chat table
      ['--sub', a.sub, '--all-users', '--table', store.tableName, '--ledger-table', ledger.tableName, ...rest],
      ['--table', store.tableName, '--ledger-table', ledger.tableName, ...rest],                      // neither --sub nor --all-users
      ['--all-users', '--ledger-table', store.tableName, '--table', store.tableName, ...rest],
    ]
    for (const argv of cases) {
      const result = await cli(argv, evidence([[id, 1]]))
      expect(result.code, argv.join(' ')).toBe(1)
    }
    expect(await snapshot(id)).toEqual(before)
  })

  test('refuses missing target, wrong account, unknown subject, synthetic identity and bad arguments', async () => {
    const a = await provisionUser()
    const id = await reserve(a)
    age()
    const before = await snapshot(id)
    const ok = ['--sub', a.sub, '--month', month]
    const withEvidence = [...ok, '--evidence', 'e.json']
    const file = evidence([[id, 1]])
    const wrongAccount = target().map(v => v === arn.account ? '111111111111' : v)
    const cases: Array<[string[], unknown, Record<string, string | undefined>?]> = [
      [ok, undefined], [[...ok, ...wrongAccount], undefined], [['--sub', randomUUID(), '--month', month, ...target()], undefined],
      [[...ok, ...target()], undefined, { ARTURIA_IDENTITY_MODE: 'fixture' }],
      [[...ok, '--apply', ...target()], undefined],
      [['--sub', a.sub, ...target()], undefined],
      [['--sub', a.sub, '--month', '2035-13', ...target()], undefined],
      [[...ok, '--scope', 'shared', ...target()], undefined],
      [[...withEvidence, ...target()], new Error('ENOENT')],
      [[...withEvidence, ...target()], { month, entries: 'x' }],
      [[...withEvidence, '--apply', '--unknown', ...target()], file],
    ]
    for (const [argv, content, env] of cases) {
      const result = await cli(argv, content, env)
      expect(result.code, argv.join(' ')).toBe(1)
    }
    expect(await snapshot(id)).toEqual(before)
  })
})
