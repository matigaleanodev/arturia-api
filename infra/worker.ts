// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Duration, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_sqs as sqs } from 'aws-cdk-lib'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import type { Construct } from 'constructs'
import type { ProviderMode } from '../src/config/runtime.ts'
import { TIMING, checkTiming, type Timing } from '../src/config/timing.ts'
import { mapEventSourcesByArn } from './event-source-arn.ts'

/** Item actions of the generation worker, including those inside its transactions. It never queries. */
export const WORKER_TABLE_ACTIONS = ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']

interface WorkerProps {
  readonly table: dynamodb.ITable
  readonly queue: sqs.IQueue
  readonly code: lambda.Code
  /** Predefined execution role. When it is immutable, its grants live outside this stack. */
  readonly role?: iam.IRole
  readonly functionName?: string
  readonly providerMode?: ProviderMode
  readonly timing?: Timing
  /** Operational kill switch: a paused worker leaves messages in the queue (14-day retention) and turns untouched. */
  readonly paused?: boolean
}

/**
 * Generation worker fed by the turn queue: one message per invocation, so a failure only returns that
 * turn and the FIFO rule of returning the rest of a batch never applies. The event source caps
 * concurrency instead of reserved concurrency.
 */
export function addWorker(scope: Construct, { table, queue, code, role, functionName, providerMode = 'fixture', timing = TIMING,
  paused = false }: WorkerProps) {
  const t = checkTiming(timing)
  const worker = new lambda.Function(scope, 'GenerationWorker', {
    functionName, runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code, role,
    timeout: Duration.seconds(t.workerTimeoutSeconds), memorySize: 256,
    environment: { ARTURIA_TABLE_NAME: table.tableName, ARTURIA_ENVIRONMENT: 'pilot', ARTURIA_PROVIDER_MODE: providerMode },
  })
  worker.addToRolePolicy(new iam.PolicyStatement({ actions: WORKER_TABLE_ACTIONS, resources: [table.tableArn] }))
  worker.addEventSource(new SqsEventSource(queue, {
    batchSize: 1, reportBatchItemFailures: true, maxConcurrency: t.workerMaxConcurrency, enabled: !paused,
  }))
  mapEventSourcesByArn(worker)
  return worker
}
