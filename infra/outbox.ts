// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Duration, RemovalPolicy, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_sqs as sqs } from 'aws-cdk-lib'
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources'
import type { Construct } from 'constructs'
import { TIMING, checkTiming, type Timing } from '../src/config/timing.ts'
import { TABLE_LIMITS } from './cost-controls.ts'

export interface OutboxNames {
  readonly table: string
  readonly turnQueue: string
  readonly turnDeadLetters: string
  readonly relayDeadLetters: string
}

export function addOutbox(scope: Construct, relay: lambda.Function, names?: OutboxNames, timing: Timing = TIMING) {
  const t = checkTiming(timing)
  const retentionPeriod = Duration.days(t.turnRetentionDays)
  const table = new dynamodb.Table(scope, 'ChatTable', {
    tableName: names?.table,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    maxReadRequestUnits: TABLE_LIMITS.maxReadRequestUnits,
    maxWriteRequestUnits: TABLE_LIMITS.maxWriteRequestUnits,
    stream: dynamodb.StreamViewType.KEYS_ONLY,
    // Synthetic pilot data (D3): deleted with the stack, no point-in-time recovery or deletion protection.
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    deletionProtection: false,
    removalPolicy: RemovalPolicy.DESTROY,
  })
  const workerDlq = new sqs.Queue(scope, 'TurnDeadLetters', { queueName: names?.turnDeadLetters, fifo: true, retentionPeriod })
  // Retention outlives a paused worker; the visibility follows the timing invariant.
  const turnQueue = new sqs.Queue(scope, 'TurnQueue', {
    queueName: names?.turnQueue, fifo: true, retentionPeriod, visibilityTimeout: Duration.seconds(t.turnVisibilitySeconds),
    deadLetterQueue: { queue: workerDlq, maxReceiveCount: t.turnMaxReceives },
  })
  const streamDlq = new sqs.Queue(scope, 'RelayDeadLetters', { queueName: names?.relayDeadLetters, retentionPeriod })
  relay.addEnvironment('ARTURIA_TABLE_NAME', table.tableName)
  relay.addEnvironment('ARTURIA_TURN_QUEUE_URL', turnQueue.queueUrl)
  relay.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [table.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'OUTBOX#*' },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    },
  }))
  turnQueue.grantSendMessages(relay)
  relay.addEventSource(new DynamoEventSource(table, {
    startingPosition: lambda.StartingPosition.TRIM_HORIZON, batchSize: 10,
    filters: [lambda.FilterCriteria.filter({ dynamodb: { Keys: {
      pk: { S: lambda.FilterRule.beginsWith('OUTBOX#') }, sk: { S: lambda.FilterRule.beginsWith('OUTBOX#') },
    } } })],
    retryAttempts: 5, maxRecordAge: Duration.hours(22), reportBatchItemFailures: true,
    onFailure: new SqsDlq(streamDlq),
  }))
  return { table, turnQueue, workerDlq, streamDlq }
}
