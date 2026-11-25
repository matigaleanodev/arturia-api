// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, inject, test, vi } from 'vitest'
import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { applyProvision } from '../../src/admin/provision.js'
import { pendingOutboxFor, republishOutbox } from '../../src/admin/outbox-recovery.js'
import { runRepublish } from '../../src/admin/cli.js'
import { InjectedFailure, createWorkerHandler } from '../../src/chat/generate.lambda.js'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore, turnKey } from '../../src/chat/turns.store.js'
import type { TurnReference } from '../../src/chat/turns.types.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import type { Provider } from '../../src/models/provider.js'
import { SimulatedProvider } from '../../src/models/simulated.js'
import { integrationDatabase, localDynamoClient } from '../support/dynamodb.js'
import { FifoTurnQueue, deliver } from '../support/fifo-queue.js'
import { TestQueue } from '../support/test-queue.js'

let local: ReturnType<typeof integrationDatabase>
let store: ChatStore
let arn: { account: string; region: string }
let time: number

interface User { sub: string; userId: string; sessionId: string }
async function provisionUser(): Promise<User> {
  const sub = randomUUID()
  const { userId } = await applyProvision(store.db, store.tableName, sub, { mfaVerifiedAt: 1 })
  const sessionId = 'fixture-family-' + randomUUID()
  await store.registerSession(userId!, sessionId, 2)
  return { sub, userId: userId!, sessionId }
}
// The relay never ran: the outbox row stays pending, as after a relay outage that exhausted its retries.
async function acceptUnrelayed(user: User, scopeId = 'personal'): Promise<TurnReference> {
  const chat = createChat(store)
  const actor = { userId: user.userId, sessionId: user.sessionId }
  const c = await chat.createConversation(actor, scopeId, {})
  const t = await chat.acceptTurn(actor, scopeId, c.conversationId, randomUUID(), { text: 'Entrada sintética' })
  return { userId: user.userId, scopeId, turnId: t.turnId }
}
const turn = (ref: TurnReference) => store.read(turnKey(ref).pk, turnKey(ref).sk)
function counting(provider: Provider = new SimulatedProvider()) {
  const stream = vi.fn(provider.stream.bind(provider))
  return { provider: { stream } as Provider, calls: () => stream.mock.calls.length }
}
const handlerFor = (provider: Provider) => {
  const worker = createGenerationWorker(store, provider)
  return createWorkerHandler({ log: () => {}, run: (ref, id) => worker.runTurn(ref, id) })
}

beforeEach(async () => {
  time = Date.UTC(2026, 0, 1)
  local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName, () => new Date(time))
  const { Table } = await local.client.send(new DescribeTableCommand({ TableName: local.tableName }))
  const [, , , region, account] = Table!.TableArn!.split(':')
  arn = { account: account!, region: region! }
})
afterEach(() => local.client.destroy())

describe('outbox recovery core', () => {
  test('republish_outbox_is_idempotent', async () => {
    const user = await provisionUser()
    const refs = [await acceptUnrelayed(user, 'personal'), await acceptUnrelayed(user, 'work')]
    expect(await pendingOutboxFor(store, user.userId)).toEqual(expect.arrayContaining(refs))
    const queue = new TestQueue()
    expect(await republishOutbox(store, queue, refs)).toEqual({ published: 2, skipped: 0 })
    expect(await republishOutbox(store, queue, refs)).toEqual({ published: 0, skipped: 2 })
    expect([queue.take(), queue.take(), queue.take()].filter(Boolean)).toHaveLength(2)
    expect(await pendingOutboxFor(store, user.userId)).toEqual([])
  })

  test('republish_stops_at_first_send_failure_and_keeps_remaining_pending', async () => {
    const user = await provisionUser()
    const refs = [await acceptUnrelayed(user), await acceptUnrelayed(user)]
    const queue = new TestQueue()
    queue.failNextSend(new Error('fixture send failure'))
    await expect(republishOutbox(store, queue, refs)).rejects.toThrow('fixture send failure')
    expect(await pendingOutboxFor(store, user.userId)).toHaveLength(2)
    expect(await republishOutbox(store, queue, refs)).toEqual({ published: 2, skipped: 0 })
  })

  test('republish_after_crash_between_send_and_mark_runs_the_turn_once', async () => {
    const user = await provisionUser()
    const ref = await acceptUnrelayed(user)
    const fifo = new FifoTurnQueue()
    // The relay sent the message and crashed before marking the outbox row.
    fifo.send(ref)
    const { provider, calls } = counting()
    expect(await deliver(fifo, time, handlerFor(provider))).toBe('deleted')
    expect(await turn(ref)).toMatchObject({ status: 'completed' })
    const before = await turn(ref)
    // Republishing outside the deduplication window delivers a second copy of the reference.
    const replay = new FifoTurnQueue()
    expect(await republishOutbox(store, replay, [ref])).toEqual({ published: 1, skipped: 0 })
    expect(await deliver(replay, time, handlerFor(provider))).toBe('deleted')
    expect(calls()).toBe(1)
    expect(await turn(ref)).toEqual(before)
  })

  test('republish_only_reads_the_requested_user', async () => {
    const a = await provisionUser()
    const b = await provisionUser()
    await acceptUnrelayed(a)
    const bRef = await acceptUnrelayed(b)
    const queue = new TestQueue()
    await republishOutbox(store, queue, await pendingOutboxFor(store, a.userId))
    expect(await pendingOutboxFor(store, b.userId)).toEqual([bRef])
  })
})

describe('queued turn recovery', () => {
  test('turn_left_queued_by_exhausted_receives_completes_once_after_redrive', async () => {
    const user = await provisionUser()
    const ref = await acceptUnrelayed(user)
    const fifo = new FifoTurnQueue()
    await publishOutbox(store, fifo, ref)
    // Pilot `fail` mode: every receive fails until the DLQ, and the turn stays queued without a send.
    const failing = createWorkerHandler({ log: () => {}, run: async () => { throw new InjectedFailure() } })
    let now = time
    while (fifo.depth.queued) { await deliver(fifo, now, failing); now += 400_000 }
    expect(fifo.depth).toEqual({ queued: 0, deadLetters: 1 })
    expect(await turn(ref)).toMatchObject({ status: 'queued', lastSeq: 0 })
    expect((await turn(ref))?.sendState).toBeUndefined()
    // The outbox is already published: republish does not see it. Recovery is the DLQ redrive.
    expect(await pendingOutboxFor(store, user.userId)).toEqual([])
    fifo.redrive()
    const { provider, calls } = counting()
    expect(await deliver(fifo, now, handlerFor(provider))).toBe('deleted')
    expect(await turn(ref)).toMatchObject({ status: 'completed' })
    // A second redrive of the same reference (redriven copies get a new deduplication ID) is a no-op.
    const copy = new FifoTurnQueue()
    copy.send(ref)
    expect(await deliver(copy, now, handlerFor(provider))).toBe('deleted')
    expect(calls()).toBe(1)
  })
})

describe('republish CLI', () => {
  const queueUrl = () => `https://sqs.${arn.region}.amazonaws.com/${arn.account}/arturia-pilot-turns.fifo`
  function cli(argv: string[], env: Record<string, string | undefined> = {}) {
    const out: string[] = []
    const created: DynamoDBClient[] = []
    const queues: TestQueue[] = []
    return runRepublish(argv, env, {
      createClient: () => {
        const client = localDynamoClient(inject('integrationDatabase').endpoint)
        created.push(client)
        return client
      },
      createQueue: () => { const q = new TestQueue(); queues.push(q); return q },
      out: line => out.push(line),
    }).then(code => ({ code, out: out.join('\n'), created, queues }))
  }
  const target = () => ['--table', store.tableName, '--region', arn.region, '--profile', 'fixture-profile',
    '--expected-account', arn.account]

  test('republish_outbox_is_idempotent_and_dry_run_by_default', async () => {
    const user = await provisionUser()
    await acceptUnrelayed(user)
    const dry = await cli(['--sub', user.sub, ...target()])
    expect(dry.code).toBe(0)
    expect(JSON.parse(dry.out)).toMatchObject({ mode: 'dry-run', pending: 1 })
    expect(dry.queues).toHaveLength(0)
    expect(dry.out).not.toContain(user.sub)
    expect(await pendingOutboxFor(store, user.userId)).toHaveLength(1)

    const applied = await cli(['--sub', user.sub, '--apply', '--queue-url', queueUrl(), ...target()])
    expect(applied.code).toBe(0)
    expect(JSON.parse(applied.out)).toMatchObject({ mode: 'apply', published: 1, skipped: 0 })
    expect(applied.queues[0]?.take()).toBeTruthy()
    const again = await cli(['--sub', user.sub, '--apply', '--queue-url', queueUrl(), ...target()])
    expect(JSON.parse(again.out)).toMatchObject({ mode: 'apply', pending: 0, published: 0 })
  })

  test('apply_requires_queue_in_the_expected_account_and_region', async () => {
    const user = await provisionUser()
    await acceptUnrelayed(user)
    const wrongUrls = [undefined, queueUrl().replace(arn.account, '111111111111'),
      queueUrl().replace(`sqs.${arn.region}.`, 'sqs.sa-east-1.'), queueUrl().replace('.fifo', ''),
      queueUrl().replace('https://', 'http://'), queueUrl().replace('turns.fifo', 'turns-dlq.fifo'),
      queueUrl().replace('arturia-pilot-turns.fifo', 'other.fifo')]
    for (const url of wrongUrls) {
      const result = await cli(['--sub', user.sub, '--apply', ...(url ? ['--queue-url', url] : []), ...target()])
      expect(result.code, String(url)).toBe(1)
      expect(result.queues).toHaveLength(0)
    }
    expect(await pendingOutboxFor(store, user.userId)).toHaveLength(1)
  })

  test('refuses_missing_target_unknown_subject_and_synthetic_identity', async () => {
    const user = await provisionUser()
    expect((await cli(['--sub', user.sub])).code).toBe(1)
    const otherAccount = target().map(v => v === arn.account ? '111111111111' : v)
    expect((await cli(['--sub', user.sub, ...otherAccount])).code).toBe(1)
    const unknown = await cli(['--sub', randomUUID(), ...target()])
    expect(unknown.code).toBe(1)
    const synthetic = await cli(['--sub', user.sub, ...target()], { ARTURIA_IDENTITY_MODE: 'fixture' })
    expect(synthetic.code).toBe(1)
    expect(synthetic.created).toHaveLength(0)
    expect((await cli(['--sub', user.sub, '--scope', 'shared', ...target()])).code).toBe(1)
  })
})
