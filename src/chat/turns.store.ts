// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { createHash, randomUUID } from 'node:crypto'
import { TransactionCanceledException, ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
  type QueryCommandInput, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { Actor, IdentityStore, SessionState } from '../identity/actor.js'
import type { Action, PolicyStore } from '../identity/policy.js'
import { ChatError, forbidden, notFound, type TurnInput, type ConversationInput, type ConversationSummary, type TurnSnapshot, type TurnReference } from './turns.types.js'

type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>
export const scopePartition = (userId: string, scopeId: string) => JSON.stringify([userId, scopeId])
const outboxPartition = (userId: string, scopeId: string) => 'OUTBOX#' + scopePartition(userId, scopeId)
export const turnKey = (ref: TurnReference) => ({ pk: scopePartition(ref.userId, ref.scopeId), sk: 'TURN#' + ref.turnId })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const grantKey = (actor: Actor, scopeId: string) => ({ pk: scopePartition(actor.userId, scopeId), sk: 'SCOPE' })
const userKey = (userId: string, sk: string) => ({ pk: JSON.stringify([userId]), sk })
const messagePrefix = (conversationId: string) => 'MESSAGE#' + conversationId + '#'

export class ChatStore implements IdentityStore, PolicyStore {
  readonly db: DynamoDBDocumentClient
  constructor(client: DynamoDBClient, readonly tableName: string, readonly now = () => new Date()) {
    this.db = DynamoDBDocumentClient.from(client)
  }

  async read(pk: string, sk: string) {
    const { Item } = await this.db.send(new GetCommand({
      TableName: this.tableName, Key: { pk, sk }, ConsistentRead: true,
    }))
    return Item
  }

  private async *query(pk: string, prefix: string, filter?: 'pending') {
    let cursor: QueryCommandInput['ExclusiveStartKey']
    do {
      const page = await this.db.send(new QueryCommand({
        TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey: cursor,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix, ...(filter && { ':state': filter }) },
        ...(filter && { FilterExpression: 'dispatchState = :state' }),
      }))
      yield* page.Items ?? []
      cursor = page.LastEvaluatedKey
    } while (cursor)
  }

  async findUserIdBySubject(subject: string) {
    return (await this.read('SUBJECT', subject))?.userId as string | undefined
  }
  async getAccount(userId: string) {
    const row = await this.read(JSON.stringify([userId]), 'ACCOUNT')
    if (row?.status === 'disabled') return { status: 'disabled' } as const
    if (row?.status === 'active') return { status: 'active', mfaVerifiedAt: row.mfaVerifiedAt } as const
  }
  async getSession(userId: string, sessionId: string): Promise<SessionState | undefined> {
    const row = await this.read(JSON.stringify([userId]), 'SESSION#' + sessionId)
    if (row?.status === 'revoked') return { status: 'revoked' }
    if (row?.status === 'active') return { status: 'active', authTime: row.authTime }
  }
  async registerSession(userId: string, sessionId: string, authTime: number): Promise<SessionState> {
    try {
      await this.db.send(new PutCommand({ TableName: this.tableName,
        Item: { ...userKey(userId, 'SESSION#' + sessionId), status: 'active', authTime },
        ConditionExpression: 'attribute_not_exists(pk)',
      }))
      return { status: 'active', authTime }
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error
      return await this.getSession(userId, sessionId) ?? { status: 'revoked' }
    }
  }
  async getScopeActions(userId: string, scopeId: string) {
    const actions = (await this.read(scopePartition(userId, scopeId), 'SCOPE'))?.actions
    return actions instanceof Set ? [...actions] as Action[] : undefined
  }
  async hasResource(userId: string, scopeId: string, kind: 'conversation' | 'turn', id: string) {
    return !!await this.read(scopePartition(userId, scopeId), kind.toUpperCase() + '#' + id)
  }

  // Close the interval between the policy read and the durable write.
  async writeGuards(actor: Actor, scopeId: string, action: Action): Promise<Writes> {
    const session = await this.getSession(actor.userId, actor.sessionId)
    if (session?.status !== 'active' || !Number.isSafeInteger(session.authTime)) throw forbidden()
    const TableName = this.tableName
    return [
      { ConditionCheck: { TableName, Key: userKey(actor.userId, 'ACCOUNT'),
        ConditionExpression: '#status = :active AND mfaVerifiedAt >= :zero AND mfaVerifiedAt < :auth',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':auth': session.authTime, ':zero': 0 } } },
      { ConditionCheck: { TableName, Key: userKey(actor.userId, 'SESSION#' + actor.sessionId),
        ConditionExpression: '#status = :active AND authTime = :auth',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active', ':auth': session.authTime } } },
      { ConditionCheck: { TableName, Key: grantKey(actor, scopeId),
        ConditionExpression: 'contains(#actions, :action)', ExpressionAttributeNames: { '#actions': 'actions' },
        ExpressionAttributeValues: { ':action': action } } },
    ]
  }

  async createConversation(actor: Actor, scopeId: string, input: ConversationInput): Promise<ConversationSummary> {
    const summary = { ...input, scopeId, conversationId: randomUUID(), createdAt: this.now().toISOString() }
    await this.transact([
      ...await this.writeGuards(actor, scopeId, 'conversation:create'),
      { Put: { TableName: this.tableName, Item: { pk: scopePartition(actor.userId, scopeId),
        sk: 'CONVERSATION#' + summary.conversationId, summary, turnCount: 0 }, ConditionExpression: 'attribute_not_exists(pk)' } },
    ])
    return summary
  }
  async listConversations(pk: string) {
    const conversations: ConversationSummary[] = []
    for await (const row of this.query(pk, 'CONVERSATION#')) conversations.push(row.summary)
    return { conversations: conversations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  }

  async getTurn(pk: string, turnId: string): Promise<TurnSnapshot> {
    const row = await this.read(pk, 'TURN#' + turnId)
    if (!row) throw notFound()
    const { scopeId, conversationId, status, lastSeq, result, error } = row
    return { scopeId, conversationId, turnId, status, lastSeq, ...(result && { result }), ...(error && { error }) }
  }
  async getConversation(pk: string, conversationId: string) {
    const row = await this.read(pk, 'CONVERSATION#' + conversationId)
    if (!row) throw notFound()
    const turns = []
    for await (const msg of this.query(pk, messagePrefix(conversationId))) {
      turns.push({ input: { text: msg.text as string }, snapshot: await this.getTurn(pk, msg.turnId) })
    }
    return { ...row.summary as ConversationSummary, turns }
  }

  private async transact(writes: Writes) {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: writes }))
    } catch (error) {
      if (error instanceof TransactionCanceledException &&
          error.CancellationReasons?.slice(0, 3).some(reason => reason.Code === 'ConditionalCheckFailed')) throw forbidden()
      throw error
    }
  }

  async acceptTurn(actor: Actor, scopeId: string, conversationId: string, key: string, input: TurnInput) {
    const pk = scopePartition(actor.userId, scopeId)
    const TableName = this.tableName
    const receiptSk = 'IDEMPOTENCY#' + digest(key)
    const fingerprint = digest(JSON.stringify([conversationId, input.text]))
    const conversationSk = 'CONVERSATION#' + conversationId
    const turnId = randomUUID()
    const guards = await this.writeGuards(actor, scopeId, 'turn:create')
    const insert = (sk: string, fields: Record<string, unknown>, partition = pk) => ({
      Put: { TableName, Item: { pk: partition, sk, ...fields }, ConditionExpression: 'attribute_not_exists(pk)' },
    })
    for (let attempt = 0; attempt < 12; attempt++) {
      const receipt = await this.read(pk, receiptSk)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ChatError(409, 'IDEMPOTENCY_CONFLICT', 'La clave ya se usó para otro envío.')
        return this.getTurn(pk, receipt.turnId)
      }
      const conversation = await this.read(pk, conversationSk)
      if (!conversation) throw notFound()
      const ordinal = conversation.turnCount + 1
      const messageSk = messagePrefix(conversationId) + String(ordinal).padStart(16, '0')
      const snapshot: TurnSnapshot = { scopeId, conversationId, turnId, status: 'queued', lastSeq: 0 }
      try {
        await this.transact([
          ...guards,
          { Update: { TableName, Key: { pk, sk: conversationSk }, UpdateExpression: 'SET turnCount = :next',
            ConditionExpression: 'turnCount = :previous',
            ExpressionAttributeValues: { ':next': ordinal, ':previous': conversation.turnCount } } },
          insert(messageSk, { text: input.text, turnId }),
          insert('TURN#' + turnId, { ...snapshot, sessionId: actor.sessionId, messageSk }),
          insert('OUTBOX#' + turnId, { dispatchState: 'pending' }, outboxPartition(actor.userId, scopeId)),
          insert(receiptSk, { fingerprint, turnId }),
        ])
        return snapshot
      } catch (error) {
        if (!(error instanceof TransactionCanceledException) || !error.CancellationReasons?.some(
          reason => reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict',
        )) throw error
        // The competing transaction may have committed the receipt or advanced the conversation.
        await new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(100, 4 * 2 ** attempt)))
      }
    }
    throw new ChatError(503, 'RETRY_LATER', 'Reintentá el envío con la misma clave.')
  }

  async outboxPending(ref: TurnReference) {
    return (await this.read(outboxPartition(ref.userId, ref.scopeId), 'OUTBOX#' + ref.turnId))?.dispatchState === 'pending'
  }
  async markPublished(ref: TurnReference) {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.tableName, Key: { pk: outboxPartition(ref.userId, ref.scopeId), sk: 'OUTBOX#' + ref.turnId },
        UpdateExpression: 'SET dispatchState = :published', ConditionExpression: 'dispatchState = :pending',
        ExpressionAttributeValues: { ':pending': 'pending', ':published': 'published' },
      }))
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error
    }
  }

  async pendingOutbox(userId: string, scopeId: string) {
    const refs: TurnReference[] = []
    for await (const row of this.query(outboxPartition(userId, scopeId), 'OUTBOX#', 'pending')) {
      refs.push({ userId, scopeId, turnId: row.sk.slice('OUTBOX#'.length) })
    }
    return refs
  }
}
