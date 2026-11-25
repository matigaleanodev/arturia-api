// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PutItemCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { createChat } from '../../src/chat/turns.js'
import { ChatStore } from '../../src/chat/turns.store.js'
import { chatHttp } from '../../src/chat/turns.http.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { TestQueue } from '../support/test-queue.js'
import { fixtureTime } from '../support/fixtures.js'

let client: DynamoDBClient
let tableName: string
let store: ChatStore
let chat: ReturnType<typeof createChat>
const scopeId = 'fixture-personal'
let actor: { userId: string; sessionId: string }
const actions = ['conversation:list', 'conversation:create', 'conversation:read', 'turn:create', 'turn:read']

async function provision(user: typeof actor, scope = scopeId) {
  const userPk = JSON.stringify([user.userId])
  const items: Record<string, AttributeValue>[] = [
    { pk: { S: userPk }, sk: { S: 'ACCOUNT' }, status: { S: 'active' }, mfaVerifiedAt: { N: '1' } },
    { pk: { S: userPk }, sk: { S: 'SESSION#' + user.sessionId }, status: { S: 'active' }, authTime: { N: '2' } },
    { pk: { S: JSON.stringify([user.userId, scope]) }, sk: { S: 'SCOPE' }, actions: { SS: actions } },
  ]
  for (const item of items) await client.send(new PutItemCommand({ TableName: tableName, Item: item }))
}

beforeEach(async () => {
  const local = integrationDatabase()
  client = local.client
  tableName = local.tableName
  actor = { userId: randomUUID(), sessionId: 'fixture-session' }
  store = new ChatStore(client, tableName, () => new Date(fixtureTime))
  chat = createChat(store)
  await provision(actor)
})
afterEach(() => client.destroy())

async function conversation() {
  const response = await chatHttp(chat, { operation: 'createConversation', actor, scopeId, body: { title: 'Fixture' } })
  expect(response.status).toBe(201)
  return response.body.conversationId as string
}

function post(conversationId: string, key = 'fixture-key', body: unknown = { text: 'Fixture input' }) {
  return chatHttp(chat, { operation: 'acceptTurn', actor, scopeId, conversationId, idempotencyKey: key, body })
}

test('same_key_same_payload_one_turn', async () => {
  const id = await conversation()
  const [a, b] = await Promise.all([post(id), post(id)])
  expect(a.status).toBe(202)
  expect(b).toEqual(a)
  expect(a.body).toEqual({ turnId: expect.any(String), status: 'queued' })
  const snapshot = { ...a.body, conversationId: id, scopeId, lastSeq: 0 }
  expect(await chat.getTurn(actor, scopeId, a.body.turnId as string)).toEqual(snapshot)
  expect((await chat.getConversation(actor, scopeId, id)).turns).toEqual([{ input: { text: 'Fixture input' }, snapshot }])
  expect(await store.pendingOutbox(actor.userId, scopeId)).toEqual([{ userId: actor.userId, scopeId, turnId: a.body.turnId }])
})

test('same_key_other_payload_conflict', async () => {
  const id = await conversation()
  const responses = await Promise.all([post(id), post(id, 'fixture-key', { text: 'Other fixture' })])
  expect(responses.map(r => r.status).sort()).toEqual([202, 409])
  expect(responses.find(r => r.status === 409)?.body.code).toBe('IDEMPOTENCY_CONFLICT')
  expect((await chat.getConversation(actor, scopeId, id)).turns).toHaveLength(1)
})

test('crash_before_publish_recovered', async () => {
  const id = await conversation()
  const accepted = await post(id)
  expect(accepted.status).toBe(202)
  const queue = new TestQueue()
  const fresh = new ChatStore(client, tableName)
  const [reference] = await fresh.pendingOutbox(actor.userId, scopeId)
  queue.failNextSend(new Error('Synthetic queue unavailable'))
  await expect(publishOutbox(fresh, queue, reference)).rejects.toThrow('Synthetic queue unavailable')
  expect(await fresh.pendingOutbox(actor.userId, scopeId)).toEqual([reference])
  const pk = JSON.stringify([actor.userId, scopeId])
  const sk = 'OUTBOX#' + reference.turnId
  expect(await fresh.read(pk, sk)).toBeUndefined()
  expect(await fresh.read('OUTBOX#' + pk, sk)).toEqual({ pk: 'OUTBOX#' + pk, sk, dispatchState: 'pending' })
  await publishOutbox(fresh, queue, reference)
  await publishOutbox(fresh, queue, reference)
  expect(queue.take()).toEqual({ userId: actor.userId, scopeId, turnId: accepted.body.turnId as string })
  expect(queue.take()).toBeUndefined()
  expect(await fresh.pendingOutbox(actor.userId, scopeId)).toEqual([])
  expect((await chat.getConversation(actor, scopeId, id)).turns).toHaveLength(1)
})

test('owner_scope_identity_and_body_are_checked', async () => {
  const id = await conversation()
  const foreign = { userId: randomUUID(), sessionId: 'fixture-b' }
  await provision(foreign)
  await provision(actor, 'other')
  expect((await post(id, 'k', { text: 'fixture', userId: foreign.userId })).status).toBe(400)
  expect((await post(id, '', { text: 'fixture' })).status).toBe(400)
  const accepted = await post(id)
  expect(accepted.status).toBe(202)
  for (const [user, scope] of [[foreign, scopeId], [actor, 'other']] as const) {
    expect((await chatHttp(chat, { operation: 'getTurn', actor: user, scopeId: scope, turnId: accepted.body.turnId as string })).status).toBe(404)
    expect((await chatHttp(chat, { operation: 'acceptTurn', actor: user, scopeId: scope, conversationId: id, idempotencyKey: 'k', body: { text: 'Fixture' } })).status).toBe(404)
    expect((await chat.listConversations(user, scope)).conversations).toEqual([])
  }
  await client.send(new PutItemCommand({ TableName: tableName, Item: {
    pk: { S: JSON.stringify([actor.userId]) }, sk: { S: 'SESSION#' + actor.sessionId }, status: { S: 'revoked' },
  } }))
  expect((await post(id)).status).toBe(403)
})

test('history_in_submission_order_with_one_clock_tick', async () => {
  const id = await conversation()
  const inputs = ['first', 'second', 'third']
  for (const text of inputs) expect((await post(id, text, { text })).status).toBe(202)
  expect((await chat.getConversation(actor, scopeId, id)).turns.map(turn => turn.input.text)).toEqual(inputs)
})

test('revoked_scope_at_commit_aborts_all_turn_writes', async () => {
  const id = await conversation()
  const original = store.writeGuards.bind(store)
  vi.spyOn(store, 'writeGuards').mockImplementationOnce(async (...args) => {
    const guards = await original(...args)
    await client.send(new PutItemCommand({ TableName: tableName, Item: {
      pk: { S: JSON.stringify([actor.userId, scopeId]) }, sk: { S: 'SCOPE' }, actions: { SS: ['conversation:read'] },
    } }))
    return guards
  })
  expect((await post(id)).status).toBe(403)
  expect((await chat.getConversation(actor, scopeId, id)).turns).toEqual([])
  expect(await store.pendingOutbox(actor.userId, scopeId)).toEqual([])
  await provision(actor)
  expect((await post(id)).status).toBe(202)
})

test('lost_queue_ack_redelivers_only_the_same_durable_turn', async () => {
  const id = await conversation()
  const accepted = await post(id)
  expect(accepted.status).toBe(202)
  const [ref] = await store.pendingOutbox(actor.userId, scopeId)
  const queue = new TestQueue()
  const sendThenLoseAck = { send: () => { queue.send(ref); throw new Error('Lost acknowledgement') } }
  await expect(publishOutbox(store, sendThenLoseAck, ref)).rejects.toThrow('Lost acknowledgement')
  await publishOutbox(store, queue, ref)
  expect(queue.take()).toEqual(ref)
  expect(queue.take()).toEqual(ref)
  expect((await chat.getConversation(actor, scopeId, id)).turns).toHaveLength(1)
})

test('message_and_title_enforce_utf8_item_limits', async () => {
  const limit = 384 * 1024
  const fitting = '🌊'.repeat(limit / 4)
  const oversized = fitting + 'x'
  const create = (title: string) => chatHttp(chat, { operation: 'createConversation', actor, scopeId, body: { title } })
  expect((await create(oversized)).status).toBe(400)
  const result = await create(fitting)
  expect(result.status).toBe(201)
  const id = result.body.conversationId as string
  const bad = await post(id, 'fixture-size', { text: oversized })
  expect(bad).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } })
  expect((await post(id, 'fixture-size', { text: fitting })).status).toBe(202)
  expect((await chat.getConversation(actor, scopeId, id)).turns).toHaveLength(1)
})

test('route_ids_limit_utf8_bytes_before_store_lookup', async () => {
  const boundary = 'é'.repeat(128)
  const oversized = boundary + 'a'
  const read = (turnId: string) => chatHttp(chat, { operation: 'getTurn', actor, scopeId, turnId })
  expect((await read(boundary)).status).toBe(404)
  expect((await read(oversized)).status).toBe(400)
  expect((await chatHttp(chat, { operation: 'getConversation', actor, scopeId, conversationId: oversized })).status).toBe(400)
  expect((await chatHttp(chat, { operation: 'listConversations', actor, scopeId: oversized })).status).toBe(400)
})
