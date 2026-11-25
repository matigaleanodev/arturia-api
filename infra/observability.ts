// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import {
  RemovalPolicy, Stack, aws_apigateway as gateway, aws_cloudwatch as cloudwatch, aws_lambda as lambda, aws_logs as logs,
  aws_sns as sns, aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { TIMING, type Timing } from '../src/config/timing.ts'
import { alertEmailParameter } from './cost-controls.ts'
import { NAMES, STACKS } from './delivery.ts'

/** Lambda logs, access logs, the turn queue and both DLQs keep 14 days (D3). */
export const LOG_RETENTION_DAYS = 14
/** Evaluation period of every alarm except the hourly request volume. */
export const ALARM_PERIOD_SECONDS = 300
export const API_STAGE = 'prod'

/**
 * Alarm thresholds with their units in the name. Each alarm fires on one datapoint of one period.
 * - turnQueueAgeSeconds: oldest message in the turn queue, in-flight messages included. One redelivery after
 *   a visibility timeout is tolerated; the alarm fires before the receives are exhausted and the message moves
 *   to the DLQ. It catches a paused, stuck or failing worker even when Lambda reports no error.
 * - turnDeadLetterAgeSeconds: best effort only. SQS publishes metrics of a queue with messages for at most six
 *   hours without activity, so this fires only if something touches the DLQ around that age. The persistent
 *   signal is the visible-messages alarm, which keeps its state while data is missing.
 * - relayIteratorAgeMs: IteratorAge is published in milliseconds; the relay discards records after 22 hours.
 * - apiRequestsPerHour: Sum of Count over a one-hour period. A reconnect loop at the SSE route limit
 *   (1 request per second) reaches 3,600 per hour; interactive use of the pilot stays in the hundreds.
 */
export interface Thresholds {
  readonly deadLetterMessages: number
  readonly turnDeadLetterAgeSeconds: number
  readonly relayIteratorAgeMs: number
  readonly turnQueueAgeSeconds: number
  readonly lambdaErrors: number
  readonly lambdaThrottles: number
  readonly api5xx: number
  readonly apiRequestsPerHour: number
}

export function checkThresholds(t: Thresholds, timing: Timing = TIMING): Thresholds {
  const broken: string[] = []
  const rule = (ok: boolean, message: string) => { if (!ok) broken.push(message) }
  for (const [name, value] of Object.entries(t)) rule(Number.isSafeInteger(value) && value >= 1, `${name} must be a positive integer`)
  rule(t.turnQueueAgeSeconds > timing.turnVisibilitySeconds, 'turn queue age must tolerate one redelivery')
  rule(t.turnQueueAgeSeconds < timing.turnMaxReceives * timing.turnVisibilitySeconds,
    'turn queue age must fire before the message reaches the dead-letter queue')
  rule(t.turnDeadLetterAgeSeconds < timing.turnRetentionDays * 86_400, 'dead-letter age must fire before the retention expires')
  rule(t.relayIteratorAgeMs >= 60_000 && t.relayIteratorAgeMs < 22 * 3_600_000,
    'iterator age is in milliseconds: between one minute and the 22-hour record age')
  if (broken.length) throw new RangeError('Invalid alarm thresholds: ' + broken.join('; '))
  return t
}

export const THRESHOLDS: Thresholds = checkThresholds({
  deadLetterMessages: 1,
  turnDeadLetterAgeSeconds: 7 * 86_400,
  relayIteratorAgeMs: 300_000,
  turnQueueAgeSeconds: 600,
  lambdaErrors: 1,
  lambdaThrottles: 1,
  api5xx: 1,
  apiRequestsPerHour: 2_000,
})

/**
 * Explicit log group per function, deleted with the stack (D3). The runtime roles cannot create log
 * groups, so without these no function would log. JSON format with the application level at INFO (the
 * allowlist logger writes codes and identifiers only) and platform logs at WARN.
 */
export function addFunctionLogs(scope: Construct, functions: Record<string, lambda.CfnFunction>) {
  const groups: Record<string, logs.LogGroup> = {}
  for (const [name, fn] of Object.entries(functions)) {
    const group = new logs.LogGroup(scope, `Logs${name.replace(/[^A-Za-z0-9]/g, '')}`, {
      logGroupName: `/aws/lambda/${name}`, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY,
    })
    fn.loggingConfig = { logFormat: 'JSON', applicationLogLevel: 'INFO', systemLogLevel: 'WARN', logGroup: group.logGroupName }
    groups[name] = group
  }
  return groups
}

/** Access log fields: identifiers, route template, status and latency. No path, body, headers, identity or claims. */
export const ACCESS_LOG_FORMAT = {
  requestId: '$context.requestId',
  requestTime: '$context.requestTimeEpoch',
  httpMethod: '$context.httpMethod',
  resourcePath: '$context.resourcePath',
  status: '$context.status',
  responseLatency: '$context.responseLatency',
  integrationLatency: '$context.integration.latency',
  integrationStatus: '$context.integration.status',
  error: '$context.error.responseType',
} as const

/**
 * Stage access logs. API Gateway writes them with the account's CloudWatch role, which this stack never
 * creates: enable only after A0 confirms the role exists (D4). Execution logging and data trace stay off.
 */
export function addAccessLogs(scope: Construct, api: gateway.RestApi) {
  const group = new logs.LogGroup(scope, 'ApiAccessLogs', {
    logGroupName: NAMES.accessLogGroup, retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY,
  })
  const stage = api.deploymentStage.node.defaultChild as gateway.CfnStage
  stage.accessLogSetting = { destinationArn: group.logGroupArn, format: JSON.stringify(ACCESS_LOG_FORMAT) }
  return group
}

/** Operational alerts topic. Unencrypted: CloudWatch cannot publish to a topic using the AWS managed SNS key. */
export function addAlertsTopic(stack: Stack) {
  const topic = new sns.Topic(stack, 'Alerts', { topicName: NAMES.alertsTopic, displayName: 'Arturia pilot alerts' })
  topic.addSubscription(new subscriptions.EmailSubscription(alertEmailParameter(stack, 'AlertEmail').valueAsString))
  return topic
}

type Missing = 'ignore' | 'notBreaching'
interface AlarmSpec {
  readonly name: string
  readonly namespace: string
  readonly metric: string
  readonly dimensions: Record<string, string>
  readonly statistic: 'Maximum' | 'Sum'
  readonly threshold: number
  readonly missing: Missing
  readonly periodSeconds?: number
}

const short = (fn: string) => fn.replace(`${STACKS.pilot}-`, '')

/**
 * The thirteen alarms of D4. Dimensions use the fixed resource names, so the alarms match the published metrics
 * exactly. The DLQs are never polled: after six hours without activity SQS stops publishing their metrics, so
 * missing data keeps the alarm state instead of clearing it.
 */
export function alarmSpecs(t: Thresholds = THRESHOLDS): AlarmSpec[] {
  const sqs = (name: string, metric: string, queue: string, threshold: number, missing: Missing): AlarmSpec =>
    ({ name, namespace: 'AWS/SQS', metric, dimensions: { QueueName: queue }, statistic: 'Maximum', threshold, missing })
  const fn = (metric: 'Errors' | 'Throttles', name: string, threshold: number): AlarmSpec =>
    ({ name: `${metric.toLowerCase()}-${short(name)}`, namespace: 'AWS/Lambda', metric, dimensions: { FunctionName: name },
      statistic: 'Sum', threshold, missing: 'notBreaching' })
  const api = { ApiName: NAMES.restApi, Stage: API_STAGE }
  return [
    sqs('turns-dlq-visible', 'ApproximateNumberOfMessagesVisible', NAMES.turnDeadLetters, t.deadLetterMessages, 'ignore'),
    sqs('turns-dlq-age', 'ApproximateAgeOfOldestMessage', NAMES.turnDeadLetters, t.turnDeadLetterAgeSeconds, 'ignore'),
    sqs('relay-dlq-visible', 'ApproximateNumberOfMessagesVisible', NAMES.relayDeadLetters, t.deadLetterMessages, 'ignore'),
    { name: 'relay-iterator-age', namespace: 'AWS/Lambda', metric: 'IteratorAge', dimensions: { FunctionName: NAMES.relayFunction },
      statistic: 'Maximum', threshold: t.relayIteratorAgeMs, missing: 'notBreaching' },
    // The event source polls this queue while the worker runs. With the kill switch on, a queue without new
    // messages sleeps after six hours and the alarm may return to OK; its first notice has already been sent.
    sqs('turns-queue-age', 'ApproximateAgeOfOldestMessage', NAMES.turnQueue, t.turnQueueAgeSeconds, 'notBreaching'),
    ...[NAMES.httpFunction, NAMES.streamFunction, NAMES.workerFunction, NAMES.relayFunction].map(name => fn('Errors', name, t.lambdaErrors)),
    ...[NAMES.httpFunction, NAMES.streamFunction].map(name => fn('Throttles', name, t.lambdaThrottles)),
    { name: 'api-5xx', namespace: 'AWS/ApiGateway', metric: '5XXError', dimensions: api, statistic: 'Sum', threshold: t.api5xx,
      missing: 'notBreaching' },
    { name: 'api-requests', namespace: 'AWS/ApiGateway', metric: 'Count', dimensions: api, statistic: 'Sum',
      threshold: t.apiRequestsPerHour, missing: 'notBreaching', periodSeconds: 3_600 },
  ]
}

export function addAlarms(scope: Construct, topic: sns.ITopic, specs: AlarmSpec[] = alarmSpecs()) {
  return specs.map(spec => new cloudwatch.CfnAlarm(scope, `Alarm${spec.name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())}`, {
    alarmName: `${STACKS.pilot}-${spec.name}`,
    namespace: spec.namespace, metricName: spec.metric,
    dimensions: Object.entries(spec.dimensions).map(([name, value]) => ({ name, value })),
    statistic: spec.statistic, period: spec.periodSeconds ?? ALARM_PERIOD_SECONDS,
    threshold: spec.threshold, evaluationPeriods: 1, datapointsToAlarm: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold', treatMissingData: spec.missing,
    actionsEnabled: true, alarmActions: [topic.topicArn],
  }))
}
