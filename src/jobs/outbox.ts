// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { createHash } from 'node:crypto'
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import type { ChatStore } from '../chat/turns.store.js'
import type { TurnReference } from '../chat/turns.types.js'

export interface TurnQueue { send(ref: TurnReference): void | Promise<void> }

export function sqsMessage(queueUrl: string, { userId, scopeId, turnId }: TurnReference) {
  return {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ userId, scopeId, turnId }),
    MessageGroupId: createHash('sha256').update(JSON.stringify([userId, scopeId])).digest('hex'),
    MessageDeduplicationId: turnId,
  }
}
export function sqsTurnQueue(client: SQSClient, url: string): TurnQueue {
  return { async send(ref) { await client.send(new SendMessageCommand(sqsMessage(url, ref))) } }
}

export async function publishOutbox(store: ChatStore, queue: TurnQueue, ref: TurnReference) {
  if (!await store.outboxPending(ref)) return
  // A crash after send can redeliver this reference. The worker claims the durable turn by ID.
  await queue.send({ userId: ref.userId, scopeId: ref.scopeId, turnId: ref.turnId })
  await store.markPublished(ref)
}
