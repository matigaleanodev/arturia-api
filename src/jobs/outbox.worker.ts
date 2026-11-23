// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { ChatStore } from '../chat/turns.store.js'
import type { TurnReference } from '../chat/turns.types.js'
import { publishOutbox, sqsTurnQueue } from './outbox.js'

interface StreamRecord {
  readonly eventName?: string
  readonly dynamodb?: {
    readonly SequenceNumber?: string
    readonly Keys?: { readonly pk?: { readonly S?: string }; readonly sk?: { readonly S?: string } }
  }
}
interface StreamBatch { readonly Records: readonly StreamRecord[] }

export function streamReference(record: StreamRecord): TurnReference | undefined {
  const keys = record.dynamodb?.Keys
  const pk = keys?.pk?.S
  if (record.eventName !== 'INSERT' || !pk?.startsWith('OUTBOX#') || !keys?.sk?.S?.startsWith('OUTBOX#')) return
  const partition: unknown = JSON.parse(pk.slice('OUTBOX#'.length))
  const turnId = keys.sk.S.slice('OUTBOX#'.length)
  if (!Array.isArray(partition) || partition.length !== 2 || !turnId ||
      !partition.every(part => typeof part === 'string' && part.length > 0)) {
    throw new Error('Invalid outbox reference')
  }
  return { userId: partition[0], scopeId: partition[1], turnId }
}

export async function relayBatch(event: StreamBatch, publish: (ref: TurnReference) => Promise<void>) {
  for (const record of event.Records) {
    try {
      const ref = streamReference(record)
      if (ref) await publish(ref)
    } catch (error) {
      const sequence = record.dynamodb?.SequenceNumber
      if (!sequence) throw error
      return { batchItemFailures: [{ itemIdentifier: sequence }] }
    }
  }
  return { batchItemFailures: [] }
}

const dynamo = new DynamoDBClient({})
const sqs = new SQSClient({})
export function handler(event: StreamBatch) {
  const { ARTURIA_TABLE_NAME, ARTURIA_TURN_QUEUE_URL } = process.env
  if (!ARTURIA_TABLE_NAME || !ARTURIA_TURN_QUEUE_URL) throw new Error('Missing outbox configuration')
  const store = new ChatStore(dynamo, ARTURIA_TABLE_NAME)
  const queue = sqsTurnQueue(sqs, ARTURIA_TURN_QUEUE_URL)
  return relayBatch(event, ref => publishOutbox(store, queue, ref))
}
