// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App, Stack, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { expect, test } from 'vitest'
import { TIMING, checkTiming, type Timing } from '../src/config/timing.ts'
import { addOutbox } from './outbox.ts'
import { addWorker } from './worker.ts'

const code = lambda.Code.fromInline('exports.handler=async()=>{}')
function compose(timing: Timing) {
  const stack = new Stack(new App(), 'Fixture')
  const relay = new lambda.Function(stack, 'FixtureRelay', { runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code })
  const { table, turnQueue } = addOutbox(stack, relay, undefined, timing)
  addWorker(stack, { table, queue: turnQueue, code, timing, ledgerTableName: 'arturia-pilot-ledger' })
  return Template.fromStack(stack)
}

test('timing_invariants_hold', () => {
  const t = checkTiming(TIMING)
  expect(t).toMatchObject({ providerTimeoutSeconds: 45, workerTimeoutSeconds: 60, leaseSeconds: 75, turnVisibilitySeconds: 360 })
  // Provider timeout plus closing margin < worker timeout <= lease < visibility.
  expect(t.providerTimeoutSeconds + t.closeMarginSeconds).toBeLessThan(t.workerTimeoutSeconds)
  expect(t.workerTimeoutSeconds).toBeLessThanOrEqual(t.leaseSeconds)
  // The lease starts when the invocation claims the turn, at most one worker timeout after the receive.
  expect(t.workerTimeoutSeconds + t.leaseSeconds).toBeLessThan(t.turnVisibilitySeconds)
  // AWS guidance for SQS event sources: visibility of at least six times the function timeout.
  expect(t.turnVisibilitySeconds).toBeGreaterThanOrEqual(6 * t.workerTimeoutSeconds)
  expect(t.turnMaxReceives).toBeGreaterThanOrEqual(5)
  expect(t.workerMaxConcurrency).toBe(2)
  expect(t.sseFunctionTimeoutSeconds).toBeLessThan(t.sseIntegrationTimeoutSeconds)
})

test.each([
  ['provider plus margin reaches the worker timeout', { closeMarginSeconds: 15 }],
  ['lease shorter than the worker timeout', { leaseSeconds: 59 }],
  ['visibility not above the lease window', { turnVisibilitySeconds: 120 }],
  ['visibility below six worker timeouts', { turnVisibilitySeconds: 359 }],
  ['visibility above the SQS maximum', { workerTimeoutSeconds: 900, leaseSeconds: 900, turnVisibilitySeconds: 43_201 }],
  ['worker timeout above the Lambda maximum', { workerTimeoutSeconds: 901, leaseSeconds: 901, turnVisibilitySeconds: 6000 }],
  ['too few receives before the DLQ', { turnMaxReceives: 4 }],
  ['retention above 14 days', { turnRetentionDays: 15 }],
  ['concurrency below the AWS minimum', { workerMaxConcurrency: 1 }],
  ['SSE function not below its integration', { sseFunctionTimeoutSeconds: 29 }],
  ['non-integer duration', { leaseSeconds: 75.5 }],
] as const)('check_timing_rejects_%s', (_name, override) => {
  expect(() => checkTiming({ ...TIMING, ...override })).toThrow(RangeError)
})

test('synth_rejects_visibility_not_above_worker_timeout', () => {
  const broken = { ...TIMING, turnVisibilitySeconds: TIMING.workerTimeoutSeconds }
  expect(() => compose(broken)).toThrow(/visibility/i)
  expect(() => compose({ ...TIMING, leaseSeconds: TIMING.workerTimeoutSeconds - 1 })).toThrow(/lease/i)
  expect(() => compose(TIMING)).not.toThrow()
})

test('turn_queue_retention_14_days', () => {
  const template = compose(TIMING)
  const queues = Object.values(template.findResources('AWS::SQS::Queue')).map(queue => queue.Properties)
  const turns = queues.find(queue => queue.RedrivePolicy)
  expect(turns).toMatchObject({ FifoQueue: true, MessageRetentionPeriod: 14 * 86_400,
    VisibilityTimeout: TIMING.turnVisibilitySeconds, RedrivePolicy: { maxReceiveCount: TIMING.turnMaxReceives } })
  for (const queue of queues) expect(queue.MessageRetentionPeriod, JSON.stringify(queue)).toBe(14 * 86_400)
})

test('worker_event_source_batch_one_reports_failures_and_caps_concurrency', () => {
  const template = compose(TIMING)
  const mappings = Object.values(template.findResources('AWS::Lambda::EventSourceMapping')).map(m => m.Properties)
  const sqs = mappings.filter(mapping => JSON.stringify(mapping.EventSourceArn).includes('TurnQueue'))
  expect(sqs).toHaveLength(1)
  expect(sqs[0]).toMatchObject({ BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'],
    ScalingConfig: { MaximumConcurrency: 2 } })
  expect(sqs[0].MaximumBatchingWindowInSeconds).toBeUndefined()
  const worker = Object.values(template.findResources('AWS::Lambda::Function'))
    .map(fn => fn.Properties).find(fn => fn.Environment?.Variables?.ARTURIA_PROVIDER_MODE)
  expect(worker).toMatchObject({ Timeout: TIMING.workerTimeoutSeconds, Runtime: 'nodejs24.x',
    Environment: { Variables: { ARTURIA_ENVIRONMENT: 'pilot', ARTURIA_PROVIDER_MODE: 'fixture' } } })
  // maxConcurrency replaces reserved concurrency on the worker.
  expect(worker?.ReservedConcurrentExecutions).toBeUndefined()
})
