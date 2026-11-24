// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Read-only inspection of turns for the pilot runbook. It reads one user's scope partitions only, projects
// operational attributes (never the message, the result text or blocks) and issues GetItem and Query only.

import { GetCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb'
import { outboxPartition, scopePartition, turnKey, type ChatStore } from '../chat/turns.store.js'
import type { TurnReference, TurnStatus } from '../chat/turns.types.js'

export interface InspectedTurn {
  readonly scopeId: string
  readonly turnId: string
  readonly status: TurnStatus
  /** Started attempts; each one may have reached the provider. */
  readonly claims: number
  readonly lastSeq: number
  readonly sendState?: string
  readonly acceptedAt?: number
  readonly ageSeconds?: number
  readonly leaseExpired?: boolean
  readonly outbox: 'pending' | 'published' | 'absent'
}

// Explicit allowlist: `result`, `error`, `messageSk` and `sessionId` stay in the table.
const PROJECTION = {
  ProjectionExpression: '#sk, #status, lastSeq, claims, sendState, acceptedAt, leaseUntil',
  ExpressionAttributeNames: { '#sk': 'sk', '#status': 'status' },
} as const
type Row = { sk: string; status: TurnStatus; lastSeq?: number; claims?: number; sendState?: string; acceptedAt?: number; leaseUntil?: number }

async function outboxState(store: ChatStore, ref: TurnReference): Promise<InspectedTurn['outbox']> {
  const { Item } = await store.db.send(new GetCommand({ TableName: store.tableName, ConsistentRead: true,
    Key: { pk: outboxPartition(ref.userId, ref.scopeId), sk: 'OUTBOX#' + ref.turnId },
    ProjectionExpression: 'dispatchState' }))
  return Item?.dispatchState === 'pending' ? 'pending' : Item?.dispatchState === 'published' ? 'published' : 'absent'
}

async function describe(store: ChatStore, ref: TurnReference, row: Row, now: number): Promise<InspectedTurn> {
  return {
    scopeId: ref.scopeId, turnId: ref.turnId, status: row.status, claims: row.claims ?? 0, lastSeq: row.lastSeq ?? 0,
    ...(row.sendState !== undefined && { sendState: row.sendState }),
    ...(row.acceptedAt !== undefined && { acceptedAt: row.acceptedAt, ageSeconds: Math.floor((now - row.acceptedAt) / 1000) }),
    ...(row.status === 'running' && { leaseExpired: (row.leaseUntil ?? 0) <= now }),
    outbox: await outboxState(store, ref),
  }
}

export async function inspectTurn(store: ChatStore, ref: TurnReference, now: number) {
  const { Item } = await store.db.send(new GetCommand({ TableName: store.tableName, ConsistentRead: true, Key: turnKey(ref), ...PROJECTION }))
  return Item ? describe(store, ref, Item as Row, now) : undefined
}

/**
 * Non-terminal turns (`queued` or `running`) accepted at least `olderThanMs` ago: candidates for a lost
 * message (DLQ retention or purge), a relay outage or a pause longer than the queue retention. A row
 * without `acceptedAt` predates the field and is reported too, since its age is unknown.
 */
export async function staleTurns(store: ChatStore, userId: string, scopeIds: readonly string[],
  options: { olderThanMs: number; now: number; pageSize?: number }) {
  const found: InspectedTurn[] = []
  const cutoff = options.now - options.olderThanMs
  for (const scopeId of scopeIds) {
    let cursor: QueryCommandInput['ExclusiveStartKey']
    do {
      // The filter runs after the page limit: empty pages are normal, only LastEvaluatedKey ends the walk.
      const page = await store.db.send(new QueryCommand({
        TableName: store.tableName, ConsistentRead: true, ExclusiveStartKey: cursor, Limit: options.pageSize ?? 100,
        KeyConditionExpression: 'pk = :pk AND begins_with(#sk, :turn)', FilterExpression: '#status IN (:queued, :running)',
        ...PROJECTION, ExpressionAttributeValues: { ':pk': scopePartition(userId, scopeId), ':turn': 'TURN#', ':queued': 'queued', ':running': 'running' },
      }))
      for (const row of (page.Items ?? []) as Row[]) {
        if (row.acceptedAt !== undefined && row.acceptedAt > cutoff) continue
        found.push(await describe(store, { userId, scopeId, turnId: row.sk.slice('TURN#'.length) }, row, options.now))
      }
      cursor = page.LastEvaluatedKey
    } while (cursor)
  }
  return found
}
