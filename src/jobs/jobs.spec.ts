// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { streamReference } from './outbox.worker.js'

test('filtered_stream_contains_only_an_outbox_reference', () => {
  const keys = { pk: { S: 'OUTBOX#' + JSON.stringify(['fixture-a', 'scope-a']) }, sk: { S: 'OUTBOX#turn-a' } }
  const record = { eventName: 'INSERT', dynamodb: { Keys: keys } }
  expect(streamReference(record)).toEqual({ userId: 'fixture-a', scopeId: 'scope-a', turnId: 'turn-a' })
  expect(streamReference({ ...record, dynamodb: { Keys: { ...keys, pk: { S: JSON.stringify(['fixture-a', 'scope-a']) } } } })).toBeUndefined()
  expect(streamReference({ ...record, eventName: 'MODIFY' })).toBeUndefined()
  expect(streamReference({ ...record, dynamodb: { Keys: { ...keys, sk: { S: 'MESSAGE#one' } } } })).toBeUndefined()
})

test('stream_checkpoints_before_the_failed_reference_and_retries_it', async () => {
  const { relayBatch } = await import('./outbox.worker.js')
  const records = ['first', 'second', 'third'].map((id, index) => ({
    eventName: 'INSERT', dynamodb: { SequenceNumber: String(index + 1),
      Keys: { pk: { S: 'OUTBOX#' + JSON.stringify(['user', 'scope']) }, sk: { S: 'OUTBOX#' + id } } },
  }))
  const sent: string[] = []
  const response = await relayBatch({ Records: records }, async (ref) => {
    if (ref.turnId === 'second') throw new Error('Synthetic failure')
    sent.push(ref.turnId)
  })
  expect(response.batchItemFailures).toEqual([{ itemIdentifier: '2' }])
  expect(sent).toEqual(['first'])
})

test('sqs_retries_use_the_same_fifo_deduplication_id_and_only_references', async () => {
  const { sqsMessage } = await import('./outbox.js')
  const ref = { userId: 'fixture', scopeId: 'scope', turnId: 'turn', text: 'fixture input' }
  const message = sqsMessage('fixture-url', ref)
  expect(JSON.parse(message.MessageBody)).toEqual({ userId: 'fixture', scopeId: 'scope', turnId: 'turn' })
  expect(sqsMessage('fixture-url', ref)).toEqual(message)
  expect(message.MessageDeduplicationId).toBeTruthy()
})
