// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { ConfigError, loadWorkerRuntime, memoize } from '../config/runtime.js'
import { pilotFixture } from '../models/fixture-provider.js'
import { createLog, type Log } from '../observability/log.js'
import { createGenerationWorker } from './generate.worker.js'
import { ChatStore } from './turns.store.js'
import type { TurnReference } from './turns.types.js'

interface QueueRecord { readonly messageId: string; readonly body: string }
interface QueueEvent { readonly Records: readonly QueueRecord[] }
interface BatchResponse { batchItemFailures: { itemIdentifier: string }[] }
type RunTurn = (ref: TurnReference, attemptId: string) => Promise<'done' | 'retry'>

/** The pilot `fail` mode: the turn is never run, so the queue redelivers it until the DLQ. */
export class InjectedFailure extends Error { override name = 'InjectedFailure' }

export function parseTurnMessage(body: string): TurnReference {
  const value: unknown = JSON.parse(body)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid turn message')
  const keys = Object.keys(value).sort()
  const { userId, scopeId, turnId } = value as Record<string, unknown>
  if (keys.join() !== 'scopeId,turnId,userId' ||
      ![userId, scopeId, turnId].every(part => typeof part === 'string' && part.length > 0)) throw new Error('Invalid turn message')
  return { userId, scopeId, turnId } as TurnReference
}

/**
 * Consumes one or more turn messages. Only a durable terminal state is acknowledged: `retry`, invalid
 * messages and failures become batch item failures. After the first failure the rest of the FIFO
 * batch is returned unprocessed to keep the group order.
 */
export function createWorkerHandler(deps: { run: RunTurn; log: Log; newAttemptId?: () => string }) {
  const { run, log, newAttemptId = randomUUID } = deps
  return async (event: QueueEvent): Promise<BatchResponse> => {
    const batchItemFailures: { itemIdentifier: string }[] = []
    for (const { messageId, body } of event.Records) {
      if (batchItemFailures.length) { batchItemFailures.push({ itemIdentifier: messageId }); continue }
      let ref: TurnReference
      try { ref = parseTurnMessage(body) } catch (error) {
        log('error', 'INVALID_TURN_MESSAGE', { messageId, error })
        batchItemFailures.push({ itemIdentifier: messageId })
        continue
      }
      const attemptId = newAttemptId()
      try {
        const outcome = await run(ref, attemptId)
        log(outcome === 'done' ? 'info' : 'warn', outcome === 'done' ? 'TURN_DONE' : 'TURN_RETRY', { messageId, turnId: ref.turnId, attemptId })
        if (outcome === 'retry') batchItemFailures.push({ itemIdentifier: messageId })
      } catch (error) {
        log('error', 'TURN_FAILED', { messageId, turnId: ref.turnId, attemptId, error })
        batchItemFailures.push({ itemIdentifier: messageId })
      }
    }
    return { batchItemFailures }
  }
}

const log = createLog()
// Read once per execution environment. Only the pilot fixture behaviours are deployable for now.
const consumer = memoize(() => {
  const runtime = loadWorkerRuntime(process.env)
  const fixture = pilotFixture(runtime)
  if (fixture.kind === 'fail') return createWorkerHandler({ log, run: async () => { throw new InjectedFailure() } })
  const worker = createGenerationWorker(new ChatStore(new DynamoDBClient({}), runtime.tableName), fixture.provider)
  return createWorkerHandler({ log, run: (ref, attemptId) => worker.runTurn(ref, attemptId) })
})

export async function handler(event: QueueEvent): Promise<BatchResponse> {
  let consume: ReturnType<typeof consumer>
  try {
    consume = consumer()
  } catch (error) {
    log('error', 'CONFIG_INVALID', { error, variables: error instanceof ConfigError ? error.variables : undefined })
    // Fail the whole invocation: every message returns to the queue and Lambda reports an error.
    throw new Error('Invalid runtime configuration')
  }
  return consume(event)
}
