// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { scopePartition, type ChatStore } from './turns.store.js'
import type { TurnReference } from './turns.types.js'

export const blockKey = (turnId: string, seq: number) => 'BLOCK#' + turnId + '#' + String(seq).padStart(16, '0')

// Internal reader. The caller supplies the authorized snapshot's lastSeq and
// rechecks permission before emitting the batch. A blocked snapshot has lastSeq 0.
export async function readBlocks(store: ChatStore, ref: TurnReference, after: number, lastSeq: number, limit: number) {
  if (![after, lastSeq, limit].every(Number.isSafeInteger) || after < 0 || lastSeq < 0 || limit < 1) {
    throw new RangeError('Invalid block range')
  }
  if (after >= lastSeq) return []
  const page = await store.db.send(new QueryCommand({
    TableName: store.tableName, ConsistentRead: true, Limit: Math.min(limit, 100),
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
    ExpressionAttributeValues: { ':pk': scopePartition(ref.userId, ref.scopeId),
      ':start': blockKey(ref.turnId, after + 1), ':end': blockKey(ref.turnId, lastSeq) },
  }))
  return (page.Items ?? []).map(row => ({ type: 'text' as const, turnId: ref.turnId, seq: row.seq as number, text: row.text as string }))
}

