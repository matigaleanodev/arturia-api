// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { applyProvision } from '../../src/admin/provision.js'
import { inspectTurn, staleTurns } from '../../src/admin/inspect.js'
import { runInspect } from '../../src/admin/cli.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { GenerationAttempt, readRow } from '../../src/chat/generation.store.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, outboxPartition, scopePartition, turnKey } from '../../src/chat/turns.store.js'
import type { TurnReference } from '../../src/chat/turns.types.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { SimulatedProvider } from '../../src/models/simulated.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { TestQueue } from '../support/test-queue.js'

const SECRET = 'TEXTO-PRIVADO-' + randomUUID()
const HOUR = 3_600_000
let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let time: number
let arn: { account: string; region: string }

interface User { sub: string; userId: string; sessionId: string }
async function provisionUser(): Promise<User> {
  const sub = randomUUID()
  const { userId } = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 1 })
  const sessionId = 'inspect-session-' + randomUUID()
  await store.registerSession(userId!, sessionId, 2)
  return { sub, userId: userId!, sessionId }
}
async function accept(user: User, scopeId = 'personal'): Promise<TurnReference> {
  const chat = createChat(store)
  const actor = { userId: user.userId, sessionId: user.sessionId }
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, randomUUID(), { text: SECRET })
  return { userId: user.userId, scopeId, turnId: t.turnId }
}
// State left by a worker cut off (Lambda timeout or crash) after the send marker: running, uncertain, lease ticking.
async function crashAfterSendMarker(ref: TurnReference) {
  const attempt = new GenerationAttempt(store, ref, randomUUID(), (await readRow(store, ref))!)
  expect(await attempt.claim(75_000)).toBe(true)
  expect(await attempt.update('SET sendState = :uncertain', { ':uncertain': 'uncertain' })).toBe(true)
}

/** Records every DynamoDB operation issued through the client, document client included. */
function recordCommands(client: DynamoDBClient) {
  const names: string[] = []
  const name = 'arturiaInspectRecorder' + randomUUID()
  const responses: string[] = []
  client.middlewareStack.add((next, context) => async args => {
    names.push(String(context.commandName))
    const result = await next(args)
    responses.push(JSON.stringify(result.output))
    return result
  }, { step: 'initialize', name })
  return Object.assign(names, { responses })
}
// Snapshot of one user's partitions: other integration files write to the shared table in parallel.
async function userItems(user: User) {
  const partitions = [JSON.stringify([user.userId]), ...['personal', 'work'].flatMap(scope =>
    [scopePartition(user.userId, scope), outboxPartition(user.userId, scope)])]
  const items: unknown[] = [await store.read('SUBJECT', user.sub)]
  for (const pk of partitions) {
    const { Items } = await store.db.send(new QueryCommand({ TableName: local.tableName, ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk } }))
    items.push(...Items ?? [])
  }
  return items
}

beforeEach(async () => {
  time = Date.UTC(2026, 0, 1)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  const { Table } = await local.client.send(new DescribeTableCommand({ TableName: local.tableName }))
  const [, , , region, account] = Table!.TableArn!.split(':')
  arn = { account: account!, region: region! }
})

describe('turn inspection', () => {
  test('inspect_counts_claims_of_a_turn_without_reading_content', async () => {
    const user = await provisionUser()
    const ref = await accept(user)
    const before = await inspectTurn(store, ref, time)
    expect(before).toMatchObject({ status: 'queued', claims: 0, acceptedAt: time, outbox: 'pending' })
    await createGenerationWorker(store, new SimulatedProvider()).runTurn(ref, randomUUID())
    const after = await inspectTurn(store, ref, time)
    expect(after).toMatchObject({ scopeId: 'personal', turnId: ref.turnId, status: 'completed', claims: 1, sendState: 'confirmed' })
    expect(JSON.stringify(after)).not.toContain(SECRET)
    expect(JSON.stringify(after)).not.toContain('resultado sintético')
    // The public snapshot keeps the contract: no internal bookkeeping leaks.
    const snapshot = await store.getTurn(turnKey(ref).pk, ref.turnId)
    expect(Object.keys(snapshot).sort()).toEqual(['conversationId', 'lastSeq', 'result', 'scopeId', 'status', 'turnId'])
    expect(await inspectTurn(store, { ...ref, turnId: randomUUID() }, time)).toBeUndefined()
  })

  test('uncertain_send_is_not_reclaimed_and_keeps_one_claim', async () => {
    const user = await provisionUser()
    const ref = await accept(user)
    await crashAfterSendMarker(ref)
    time += 10 * 60_000
    await createGenerationWorker(store, new SimulatedProvider()).runTurn(ref, randomUUID())
    expect(await inspectTurn(store, ref, time)).toMatchObject({ status: 'failed', claims: 1, sendState: 'uncertain' })
  })
})

describe('stale_inspection_is_read_only_and_reports_orphaned_turns', () => {
  test('reports only old non-terminal turns of the requested user, across pages', async () => {
    const user = await provisionUser()
    const other = await provisionUser()
    const queue = new TestQueue()
    const relayLost = await accept(user)                          // outbox pending: relay outage
    const messageLost = await accept(user, 'work')               // outbox published, message never consumed
    await publishOutbox(store, queue, messageLost)
    const crashed = await accept(user)                           // running, lease expired after a crash
    await crashAfterSendMarker(crashed)
    const done: TurnReference[] = []
    for (let i = 0; i < 5; i++) done.push(await accept(user))     // terminal turns interleaved with the stale ones
    for (const ref of done) await createGenerationWorker(store, new SimulatedProvider()).runTurn(ref, randomUUID())
    await accept(other)                                          // another user's stale turn stays invisible
    time += 2 * HOUR
    const fresh = await accept(user)                             // queued, younger than the threshold
    time += 10 * 60_000

    const before = await userItems(user)
    const commands = recordCommands(local.client)
    const stale = await staleTurns(store, user.userId, ['personal', 'work'], { olderThanMs: HOUR, now: time, pageSize: 2 })
    const issued = [...commands]
    // Projection: no response carries the message or result text, so content never leaves DynamoDB.
    expect(commands.responses.join('')).not.toContain(SECRET)
    expect(commands.responses.join('')).not.toContain('resultado sintético')
    expect(await userItems(user)).toEqual(before)
    expect(new Set(issued)).toEqual(new Set(['QueryCommand', 'GetItemCommand']))
    // Several pages per scope: the walk follows LastEvaluatedKey through filtered pages.
    expect(issued.filter(name => name === 'QueryCommand').length).toBeGreaterThan(4)

    const byId = Object.fromEntries(stale.map(turn => [turn.turnId, turn]))
    expect(Object.keys(byId).sort()).toEqual([relayLost.turnId, messageLost.turnId, crashed.turnId].sort())
    expect(byId[relayLost.turnId]).toMatchObject({ status: 'queued', outbox: 'pending', claims: 0 })
    expect(byId[messageLost.turnId]).toMatchObject({ scopeId: 'work', status: 'queued', outbox: 'published', claims: 0 })
    expect(byId[crashed.turnId]).toMatchObject({ status: 'running', claims: 1, sendState: 'uncertain', leaseExpired: true })
    for (const turn of stale) expect(turn.ageSeconds).toBeGreaterThanOrEqual(3_600)
    expect(byId[fresh.turnId]).toBeUndefined()
    expect(JSON.stringify(stale)).not.toContain(SECRET)
  }, 60_000)

  test('cli lists stale turns read-only with masked subject and explicit target', async () => {
    const user = await provisionUser()
    await accept(user)
    time += 3 * HOUR
    const lines: string[] = []
    const deps = { createClient: () => local.client, now: () => time, out: (line: string) => lines.push(line) }
    // The CLI destroys its client: hand it a wrapper that keeps the shared one alive.
    const keep = { ...deps, createClient: () => Object.assign(Object.create(local.client), { destroy() {} }) }
    const base = ['--sub', user.sub, '--table', local.tableName, '--region', arn.region, '--profile', 'observer',
      '--expected-account', arn.account]
    const before = await userItems(user)
    const commands = recordCommands(local.client)
    expect(await runInspect([...base, '--stale'], {}, keep)).toBe(2)
    expect(new Set(commands)).toEqual(new Set(['DescribeTableCommand', 'GetItemCommand', 'QueryCommand']))
    expect(await userItems(user)).toEqual(before)
    const report = JSON.parse(lines.at(-1)!)
    expect(report).toMatchObject({ mode: 'stale', olderThanMinutes: 60, count: 1, subject: user.sub.slice(0, 8) + '…' })
    expect(lines.join('\n')).not.toContain(user.sub)
    expect(lines.join('\n')).not.toContain(SECRET)

    // A repeated scope is read once.
    expect(await runInspect([...base, '--stale', '--scope', 'personal', '--scope', 'personal'], {}, keep)).toBe(2)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ count: 1 })
    expect(await runInspect([...base, '--stale', '--older-than-minutes', '600'], {}, keep)).toBe(0)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ count: 0 })
    const turnId = report.turns[0].turnId
    expect(await runInspect([...base, '--turn', turnId, '--scope', 'personal'], {}, keep)).toBe(0)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ mode: 'turn', turn: { turnId, claims: 0, status: 'queued' } })

    // Refusals happen before any client is created.
    let created = 0
    const counting = { ...deps, createClient: () => { created++; return local.client } }
    for (const argv of [
      ['--sub', user.sub, '--stale'],                                  // no explicit target
      [...base],                                                       // no mode
      [...base, '--stale', '--turn', turnId, '--scope', 'personal'],   // both modes
      [...base, '--turn', turnId],                                     // turn without one scope
      [...base, '--stale', '--older-than-minutes', '1'],               // threshold below the minimum
      [...base, '--stale', '--scope', 'shared'],                       // unknown scope
      [...base, '--stale', '--apply'],                                 // no writing mode exists
    ]) expect(await runInspect(argv, {}, counting), argv.join(' ')).toBe(1)
    expect(await runInspect([...base, '--stale'], { ARTURIA_IDENTITY_MODE: 'synthetic-local-only' }, counting)).toBe(1)
    expect(await runInspect([...base, '--stale'], { AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:1' }, counting)).toBe(1)
    expect(created).toBe(0)
    expect(await runInspect([...base.map(v => v === arn.account ? '999999999999' : v), '--stale'], {}, keep)).toBe(1)
  }, 30_000)
})
