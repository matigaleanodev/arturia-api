// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, test } from 'vitest'
import { TIMING } from '../src/config/timing.ts'
import { createWorkerHandler } from '../src/chat/generate.lambda.ts'
import { BUDGET, TABLE_LIMITS, checkTableLimits } from './cost-controls.ts'
import {
  BUDGET_NAME, NAMES, OPERATOR_POLICY_NAME, STACKS, SYNTHETIC_ACCOUNT, boundaryPolicy, operatorManagedPolicy, rolePolicies, type Statement,
  type Target,
} from './delivery.ts'
import { FoundationStack } from './foundation-stack.ts'
import { ALARM_PERIOD_SECONDS, LOG_RETENTION_DAYS, THRESHOLDS, checkThresholds } from './observability.ts'
import { PILOT_PROVIDER_MODES, WEB_FIXTURE_DIR, createPilotStack, resolvePilotTarget, type PilotTarget } from './pilot.ts'

const tmp: string[] = []
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'arturia-obs-')); tmp.push(dir); return dir }
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })

const synthetic: PilotTarget = {
  synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: 'infra/fixtures/bundles', webDistDir: WEB_FIXTURE_DIR }
const target: Target = { partition: 'aws', account: '111111111111', region: 'us-east-1' }
type Resource = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string }

function synth(overrides: Partial<PilotTarget> = {}) {
  const app = new App({ outdir: tempDir(), analyticsReporting: false })
  const stack = createPilotStack(app, { ...synthetic, ...overrides })
  const template = Template.fromStack(stack)
  return { template, json: template.toJSON() as { Resources: Record<string, Resource>; Parameters?: Record<string, any> } }
}
function synthFoundation() {
  const app = new App({ outdir: tempDir(), analyticsReporting: false })
  const stack = new FoundationStack(app, 'Foundation')
  const template = Template.fromStack(stack)
  return { template, json: template.toJSON() as { Resources: Record<string, Resource>; Parameters?: Record<string, any> } }
}
const ofType = (json: { Resources: Record<string, Resource> }, type: string) =>
  Object.entries(json.Resources).filter(([, resource]) => resource.Type === type)
const refId = (value: unknown) => (value as { Ref?: string })?.Ref

const FUNCTIONS = [NAMES.httpFunction, NAMES.publisherFunction, NAMES.relayFunction, NAMES.streamFunction, NAMES.workerFunction]

test('every_own_function_has_managed_log_group_with_retention', () => {
  const { json } = synth()
  const groups = new Map(ofType(json, 'AWS::Logs::LogGroup'))
  const functions = ofType(json, 'AWS::Lambda::Function')
  expect(functions.map(([, fn]) => fn.Properties!.FunctionName).sort()).toEqual([...FUNCTIONS].sort())
  for (const [, fn] of functions) {
    const name = fn.Properties!.FunctionName as string
    const config = fn.Properties!.LoggingConfig
    expect(config, name).toMatchObject({ LogFormat: 'JSON', ApplicationLogLevel: 'INFO', SystemLogLevel: 'WARN' })
    const group = groups.get(refId(config.LogGroup)!)
    expect(group, name).toBeDefined()
    expect(group!.Properties).toMatchObject({ LogGroupName: `/aws/lambda/${name}`, RetentionInDays: LOG_RETENTION_DAYS })
    expect(group!.DeletionPolicy, name).toBe('Delete')
    expect(group!.Properties!.KmsKeyId).toBeUndefined()
  }
  expect(LOG_RETENTION_DAYS).toBe(14)
  // No implicit log groups: no log retention custom resource and nothing outside the function groups and access logs.
  expect(Object.values(json.Resources).some(resource => resource.Type === 'Custom::LogRetention')).toBe(false)
  expect(groups.size).toBe(FUNCTIONS.length)
}, 20_000)

describe('access_logs_follow_decision_and_exclude_body_and_authorization', () => {
  test('off by default: no access logs and no execution logging or data trace', () => {
    const { json } = synth()
    const [[, stage]] = ofType(json, 'AWS::ApiGateway::Stage') as [[string, Resource]]
    expect(stage.Properties!.AccessLogSetting).toBeUndefined()
    for (const setting of stage.Properties!.MethodSettings ?? []) {
      expect(setting.LoggingLevel).toBeUndefined()
      expect(setting.DataTraceEnabled ?? false).toBe(false)
    }
  }, 20_000)

  test('when enabled the format is an allowlist without body, headers, identity or claims', () => {
    const { json } = synth({ apiAccessLogs: true })
    const [[, stage]] = ofType(json, 'AWS::ApiGateway::Stage') as [[string, Resource]]
    const setting = stage.Properties!.AccessLogSetting
    expect(setting).toBeDefined()
    const groups = ofType(json, 'AWS::Logs::LogGroup')
    const access = groups.find(([, group]) => group.Properties!.LogGroupName === NAMES.accessLogGroup)
    expect(access).toBeDefined()
    expect(access![1]).toMatchObject({ DeletionPolicy: 'Delete', Properties: { RetentionInDays: LOG_RETENTION_DAYS } })
    expect(JSON.stringify(setting.DestinationArn)).toContain(access![0])
    const format = JSON.parse(setting.Format)
    expect(format.requestId).toBe('$context.requestId')
    // resourcePath is the route template ({conversationId}); $context.path would carry real IDs.
    for (const value of Object.values(format) as string[]) {
      expect(value).toMatch(/^\$context\.[A-Za-z.]+$/)
      expect(value).not.toMatch(/\$context\.(path|identity|authorizer|requestOverride|responseOverride)\b|body|header|sourceIp|userAgent/i)
    }
    expect(Object.keys(format).sort()).toEqual(['error', 'httpMethod', 'integrationLatency', 'integrationStatus', 'requestId',
      'requestTime', 'resourcePath', 'responseLatency', 'status'])
    for (const setting of stage.Properties!.MethodSettings ?? []) expect(setting.LoggingLevel).toBeUndefined()
  }, 20_000)
})

test('no_real_email_or_account_in_cdk_json_or_test_template', () => {
  const cdkJson = readFileSync('cdk.json', 'utf8')
  expect(cdkJson).not.toMatch(/@/)
  expect(cdkJson).not.toMatch(/\d{12}/)
  for (const json of [synth().json, synthFoundation().json]) {
    const text = JSON.stringify(json)
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    for (const account of text.match(/\d{12}/g) ?? []) expect(account).toBe(SYNTHETIC_ACCOUNT)
  }
  const { json } = synth()
  expect(json.Parameters?.AlertEmail).toMatchObject({ Type: 'String' })
  const [[, subscription]] = ofType(json, 'AWS::SNS::Subscription') as [[string, Resource]]
  expect(subscription.Properties).toMatchObject({ Protocol: 'email', Endpoint: { Ref: 'AlertEmail' } })
  expect(synthFoundation().json.Parameters?.BudgetAlertEmail).toMatchObject({ Type: 'String' })
}, 20_000)

describe('alarms_cover_dlqs_errors_throttles_iterator_age_5xx', () => {
  const day = 86_400
  const expected = [
    { name: 'turns-dlq-visible', namespace: 'AWS/SQS', metric: 'ApproximateNumberOfMessagesVisible', dims: { QueueName: NAMES.turnDeadLetters }, statistic: 'Maximum', period: 300, threshold: 1, missing: 'ignore' },
    { name: 'turns-dlq-age', namespace: 'AWS/SQS', metric: 'ApproximateAgeOfOldestMessage', dims: { QueueName: NAMES.turnDeadLetters }, statistic: 'Maximum', period: 300, threshold: 7 * day, missing: 'ignore' },
    { name: 'relay-dlq-visible', namespace: 'AWS/SQS', metric: 'ApproximateNumberOfMessagesVisible', dims: { QueueName: NAMES.relayDeadLetters }, statistic: 'Maximum', period: 300, threshold: 1, missing: 'ignore' },
    { name: 'relay-iterator-age', namespace: 'AWS/Lambda', metric: 'IteratorAge', dims: { FunctionName: NAMES.relayFunction }, statistic: 'Maximum', period: 300, threshold: 300_000, missing: 'notBreaching' },
    { name: 'turns-queue-age', namespace: 'AWS/SQS', metric: 'ApproximateAgeOfOldestMessage', dims: { QueueName: NAMES.turnQueue }, statistic: 'Maximum', period: 300, threshold: 600, missing: 'notBreaching' },
    ...[NAMES.httpFunction, NAMES.streamFunction, NAMES.workerFunction, NAMES.relayFunction].map(fn => (
      { name: `errors-${fn.replace(`${STACKS.pilot}-`, '')}`, namespace: 'AWS/Lambda', metric: 'Errors', dims: { FunctionName: fn }, statistic: 'Sum', period: 300, threshold: 1, missing: 'notBreaching' })),
    ...[NAMES.httpFunction, NAMES.streamFunction].map(fn => (
      { name: `throttles-${fn.replace(`${STACKS.pilot}-`, '')}`, namespace: 'AWS/Lambda', metric: 'Throttles', dims: { FunctionName: fn }, statistic: 'Sum', period: 300, threshold: 1, missing: 'notBreaching' })),
    { name: 'api-5xx', namespace: 'AWS/ApiGateway', metric: '5XXError', dims: { ApiName: NAMES.restApi, Stage: 'prod' }, statistic: 'Sum', period: 300, threshold: 1, missing: 'notBreaching' },
    // Per hour, not per five minutes: the request volume threshold is defined over a one-hour period.
    { name: 'api-requests', namespace: 'AWS/ApiGateway', metric: 'Count', dims: { ApiName: NAMES.restApi, Stage: 'prod' }, statistic: 'Sum', period: 3_600, threshold: THRESHOLDS.apiRequestsPerHour, missing: 'notBreaching' },
  ]

  test('exactly the thirteen alarms, each with its metric, dimensions, statistic, period, threshold and action', () => {
    const { json } = synth()
    const alarms = ofType(json, 'AWS::CloudWatch::Alarm').map(([, alarm]) => alarm.Properties!)
    expect(alarms).toHaveLength(13)
    // The API dimensions are literal: the deployed name and stage must be the ones the alarms watch.
    const [[, restApi]] = ofType(json, 'AWS::ApiGateway::RestApi') as [[string, Resource]]
    expect(restApi.Properties!.Name).toBe(NAMES.restApi)
    const [[, stage]] = ofType(json, 'AWS::ApiGateway::Stage') as [[string, Resource]]
    expect(stage.Properties!.StageName).toBe('prod')
    const queueNames = ofType(json, 'AWS::SQS::Queue').map(([, q]) => q.Properties!.QueueName).sort()
    expect(queueNames).toEqual([NAMES.relayDeadLetters, NAMES.turnDeadLetters, NAMES.turnQueue].sort())
    const [[topicId, topic]] = ofType(json, 'AWS::SNS::Topic') as [[string, Resource]]
    expect(topic.Properties).toMatchObject({ TopicName: NAMES.alertsTopic })
    // CloudWatch cannot publish to a topic encrypted with the AWS managed SNS key.
    expect(topic.Properties!.KmsMasterKeyId).toBeUndefined()
    const resolveDim = (value: unknown) => {
      const ref = refId(value)
      if (!ref) return value
      const resource = json.Resources[ref]!
      return resource.Properties!.QueueName ?? resource.Properties!.FunctionName ?? resource.Properties!.Name ?? resource.Properties!.StageName
    }
    for (const want of expected) {
      const alarm = alarms.find(candidate => candidate.AlarmName === `arturia-pilot-${want.name}`)
      expect(alarm, want.name).toBeDefined()
      expect(alarm, want.name).toMatchObject({
        Namespace: want.namespace, MetricName: want.metric, Statistic: want.statistic, Period: want.period,
        Threshold: want.threshold, EvaluationPeriods: 1, DatapointsToAlarm: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: want.missing,
        AlarmActions: [{ Ref: topicId }],
      })
      // A unit that differs from the published one makes the alarm see no data: leave it unset.
      expect(alarm!.Unit, want.name).toBeUndefined()
      expect(alarm!.OKActions, want.name).toBeUndefined()
      const dims = Object.fromEntries(alarm!.Dimensions.map((d: { Name: string; Value: unknown }) => [d.Name, resolveDim(d.Value)]))
      expect(dims, want.name).toEqual(want.dims)
    }
  }, 20_000)

  test('thresholds keep their units and stay inside the windows they protect', () => {
    expect(ALARM_PERIOD_SECONDS).toBe(300)
    // Tolerates one redelivery after a visibility timeout, alarms before the message reaches the DLQ.
    expect(THRESHOLDS.turnQueueAgeSeconds).toBeGreaterThan(TIMING.turnVisibilitySeconds)
    expect(THRESHOLDS.turnQueueAgeSeconds).toBeLessThan(TIMING.turnMaxReceives * TIMING.turnVisibilitySeconds)
    expect(THRESHOLDS.turnDeadLetterAgeSeconds).toBeLessThan(TIMING.turnRetentionDays * 86_400)
    // IteratorAge is in milliseconds; the stream keeps records for 24 hours and the relay drops them at 22 hours.
    expect(THRESHOLDS.relayIteratorAgeMs).toBeLessThan(22 * 3_600_000)
    expect(() => checkThresholds({ ...THRESHOLDS, turnQueueAgeSeconds: TIMING.turnVisibilitySeconds })).toThrow(/redelivery/)
    expect(() => checkThresholds({ ...THRESHOLDS, turnQueueAgeSeconds: 1_800 })).toThrow(/dead-letter/)
    expect(() => checkThresholds({ ...THRESHOLDS, turnDeadLetterAgeSeconds: 14 * 86_400 })).toThrow(/retention/)
    expect(() => checkThresholds({ ...THRESHOLDS, relayIteratorAgeMs: 300 })).toThrow(/milliseconds/)
  })

  test('a partial worker failure does not raise Lambda Errors, so queue age and the DLQ alarm cover it', async () => {
    const log = () => {}
    const handler = createWorkerHandler({ log, run: async () => { throw new Error('provider down') }, newAttemptId: () => crypto.randomUUID() })
    const message = { messageId: crypto.randomUUID(), body: JSON.stringify({ userId: 'u', scopeId: 's', turnId: 't' }) }
    // The invocation resolves: Lambda records no error, the message returns to the queue as a batch item failure.
    await expect(handler({ Records: [message] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: message.messageId }] })
    const retry = createWorkerHandler({ log, run: async () => 'retry' as const })
    await expect(retry({ Records: [message] })).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: message.messageId }] })
    const { json } = synth()
    const alarms = ofType(json, 'AWS::CloudWatch::Alarm').map(([, alarm]) => alarm.Properties!)
    const nonError = alarms.filter(alarm => alarm.MetricName !== 'Errors' &&
      JSON.stringify(alarm.Dimensions).includes(NAMES.turnQueue.replace('.fifo', '')))
    expect(nonError.map(alarm => alarm.AlarmName).sort()).toEqual(
      ['arturia-pilot-turns-dlq-age', 'arturia-pilot-turns-dlq-visible', 'arturia-pilot-turns-queue-age'])
  }, 20_000)
})

describe('budget_alerts_at_5_and_8', () => {
  test('the foundation owns a tag-filtered monthly budget with direct email alerts and no actions', () => {
    const { json } = synthFoundation()
    const [[, budget]] = ofType(json, 'AWS::Budgets::Budget') as [[string, Resource]]
    expect(budget.Properties!.Budget).toMatchObject({
      BudgetName: BUDGET_NAME, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 10, Unit: 'USD' },
      CostFilters: { TagKeyValue: ['user:Project$arturia'] },
      // Credits and refunds would hide real usage on an account with promotional credits.
      CostTypes: { IncludeCredit: false, IncludeRefund: false },
    })
    const notifications = budget.Properties!.NotificationsWithSubscribers as {
      Notification: Record<string, unknown>; Subscribers: { SubscriptionType: string; Address: unknown }[] }[]
    expect(notifications.map(n => n.Notification).sort((a, b) => Number(a.Threshold) - Number(b.Threshold))).toEqual([
      { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 5, ThresholdType: 'ABSOLUTE_VALUE' },
      { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 8, ThresholdType: 'ABSOLUTE_VALUE' },
      { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 10, ThresholdType: 'ABSOLUTE_VALUE' },
    ])
    for (const n of notifications) expect(n.Subscribers).toEqual([{ SubscriptionType: 'EMAIL', Address: { Ref: 'BudgetAlertEmail' } }])
    expect(ofType(json, 'AWS::Budgets::BudgetsAction')).toEqual([])
    expect(BUDGET).toMatchObject({ limitUsd: 10, actualAlertsUsd: [5, 8], forecastAlertUsd: 10 })
    // The pilot never owns the budget, so destroying it keeps cost monitoring.
    expect(ofType(synth().json, 'AWS::Budgets::Budget')).toEqual([])
  })
})

describe('kill_switch_disables_worker_mapping', () => {
  test('the switch and the access logs are explicit true/false context values', () => {
    const read = (context: Record<string, unknown>) => (key: string) => context[key]
    expect(resolvePilotTarget(read({ 'arturia:workerPaused': 'true' }), {})).toEqual({ ...synthetic, workerPaused: true })
    expect(resolvePilotTarget(read({ 'arturia:workerPaused': false, 'arturia:apiAccessLogs': 'true' }), {}))
      .toEqual({ ...synthetic, workerPaused: false, apiAccessLogs: true })
    expect(() => resolvePilotTarget(read({ 'arturia:workerPaused': 'yes' }), {})).toThrow(/arturia:workerPaused/)
    expect(() => resolvePilotTarget(read({ 'arturia:apiAccessLogs': '1' }), {})).toThrow(/arturia:apiAccessLogs/)
  })

  test('pausing disables only the worker mapping and keeps every logical ID', () => {
    const running = synth().json
    const paused = synth({ workerPaused: true }).json
    expect(Object.keys(paused.Resources).sort()).toEqual(Object.keys(running.Resources).sort())
    const mappings = (json: typeof running) => ofType(json, 'AWS::Lambda::EventSourceMapping')
    const worker = (json: typeof running) => mappings(json).find(([, m]) => m.Properties!.ScalingConfig)!
    expect(worker(running)[1].Properties!.Enabled ?? true).toBe(true)
    expect(worker(paused)[1].Properties!.Enabled).toBe(false)
    const relay = mappings(paused).find(([, m]) => !m.Properties!.ScalingConfig)!
    expect(relay[1].Properties!.Enabled ?? true).toBe(true)
    // Nothing else changes: the queue keeps its messages and the table keeps the turns.
    const strip = (json: typeof running) => {
      const copy = structuredClone(json.Resources)
      delete copy[worker(json)[0]]!.Properties!.Enabled
      return copy
    }
    expect(strip(paused)).toEqual(strip(running))
  }, 30_000)
})

describe('provider_mode_context_selects_only_simulated_modes', () => {
  const read = (context: Record<string, unknown>) => (key: string) => context[key]
  const workerFunction = (json: { Resources: Record<string, Resource> }) =>
    ofType(json, 'AWS::Lambda::Function').find(([, fn]) => fn.Properties!.FunctionName === NAMES.workerFunction)!
  const workerMode = (json: { Resources: Record<string, Resource> }) =>
    workerFunction(json)[1].Properties!.Environment.Variables.ARTURIA_PROVIDER_MODE

  test('the context accepts only fixture and fail and is optional', () => {
    expect(PILOT_PROVIDER_MODES).toEqual(['fixture', 'fail'])
    expect(resolvePilotTarget(read({}), {})).toEqual(synthetic)
    expect(resolvePilotTarget(read({ 'arturia:providerMode': 'fixture' }), {})).toEqual({ ...synthetic, providerMode: 'fixture' })
    expect(resolvePilotTarget(read({ 'arturia:providerMode': 'fail' }), {})).toEqual({ ...synthetic, providerMode: 'fail' })
    for (const value of ['catalog', 'openai', 'anthropic', 'FIXTURE', 'Fail', '', '  ', true, 0]) {
      expect(() => resolvePilotTarget(read({ 'arturia:providerMode': value }), {}), String(value)).toThrow(/arturia:providerMode/)
    }
  })

  test('the worker runs the fixture by default and the stated mode otherwise', () => {
    expect(workerMode(synth().json)).toBe('fixture')
    expect(workerMode(synth({ providerMode: 'fixture' }).json)).toBe('fixture')
    expect(workerMode(synth({ providerMode: 'fail' }).json)).toBe('fail')
  }, 30_000)

  test('switching to fail changes only the worker variable and keeps the switch, IAM, table and logical IDs', () => {
    const strip = (json: { Resources: Record<string, Resource> }) => {
      const copy = structuredClone(json.Resources)
      delete copy[workerFunction(json)[0]]!.Properties!.Environment.Variables.ARTURIA_PROVIDER_MODE
      return copy
    }
    for (const workerPaused of [false, true]) {
      const fixture = synth({ workerPaused }).json
      const fail = synth({ workerPaused, providerMode: 'fail' }).json
      expect(Object.keys(fail.Resources).sort()).toEqual(Object.keys(fixture.Resources).sort())
      expect(strip(fail)).toEqual(strip(fixture))
      expect(fail.Parameters).toEqual(fixture.Parameters)
    }
  }, 60_000)
})

test('stack_resources_tagged', () => {
  const { json } = synth()
  const taggable = ['AWS::DynamoDB::Table', 'AWS::SQS::Queue', 'AWS::Lambda::Function', 'AWS::Logs::LogGroup', 'AWS::SNS::Topic',
    'AWS::CloudWatch::Alarm', 'AWS::S3::Bucket', 'AWS::CloudFront::Distribution', 'AWS::ApiGateway::RestApi', 'AWS::ApiGateway::Stage',
    'AWS::Lambda::EventSourceMapping']
  const tags = (resource: Resource) => {
    const raw = resource.Properties!.Tags
    return Array.isArray(raw) ? Object.fromEntries(raw.map((t: { Key: string; Value: string }) => [t.Key, t.Value])) : raw
  }
  for (const [id, resource] of Object.entries(json.Resources)) {
    if (!taggable.includes(resource.Type)) continue
    expect(tags(resource), `${resource.Type} ${id}`).toMatchObject({ Project: 'arturia', Environment: 'pilot' })
  }
  const [[, pool]] = ofType(json, 'AWS::Cognito::UserPool') as [[string, Resource]]
  expect(pool.Properties!.UserPoolTags).toMatchObject({ Project: 'arturia', Environment: 'pilot' })
  for (const [, role] of ofType(synthFoundation().json, 'AWS::IAM::Role')) expect(tags(role)).toMatchObject({ Project: 'arturia' })
}, 20_000)

test('every_tagged_resource_type_has_a_tag_permission_in_the_cloudformation_role', () => {
  const { json } = synth()
  const cfn = rolePolicies(target).cloudformation
  const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const allows = (action: string, resource: string) => cfn.some(s => s.Action.includes(action) && s.Resource.some(r => glob(r).test(resource)))
  const region = 'arn:aws:%s:us-east-1:111111111111:'
  const tagging: Record<string, [string, string]> = {
    'AWS::DynamoDB::Table': ['dynamodb:TagResource', region.replace('%s', 'dynamodb') + `table/${NAMES.table}`],
    'AWS::SQS::Queue': ['sqs:TagQueue', region.replace('%s', 'sqs') + NAMES.turnQueue],
    'AWS::Lambda::Function': ['lambda:TagResource', region.replace('%s', 'lambda') + `function:${NAMES.workerFunction}`],
    'AWS::Lambda::EventSourceMapping': ['lambda:TagResource', region.replace('%s', 'lambda') + 'event-source-mapping:uuid'],
    'AWS::Logs::LogGroup': ['logs:TagResource', region.replace('%s', 'logs') + `log-group:/aws/lambda/${NAMES.workerFunction}`],
    'AWS::SNS::Topic': ['sns:TagResource', region.replace('%s', 'sns') + NAMES.alertsTopic],
    'AWS::CloudWatch::Alarm': ['cloudwatch:TagResource', region.replace('%s', 'cloudwatch') + 'alarm:arturia-pilot-api-5xx'],
    'AWS::S3::Bucket': ['s3:PutBucketTagging', 'arn:aws:s3:::arturia-pilot-web-111111111111-us-east-1'],
    'AWS::CloudFront::Distribution': ['cloudfront:TagResource', 'arn:aws:cloudfront::111111111111:distribution/E123'],
    'AWS::CloudFront::Function': ['cloudfront:TagResource', `arn:aws:cloudfront::111111111111:function/${NAMES.rewriteFunction}`],
    'AWS::ApiGateway::RestApi': ['apigateway:PUT', 'arn:aws:apigateway:us-east-1::/tags/arn%3Aaws%3Aapigateway'],
    'AWS::ApiGateway::Stage': ['apigateway:PUT', 'arn:aws:apigateway:us-east-1::/tags/arn%3Aaws%3Aapigateway'],
    'AWS::Cognito::UserPool': ['cognito-idp:TagResource', region.replace('%s', 'cognito-idp') + 'userpool/us-east-1_abc'],
  }
  const tagged = new Set(Object.values(json.Resources)
    .filter(resource => resource.Properties?.Tags || resource.Properties?.UserPoolTags).map(resource => resource.Type))
  for (const type of tagged) {
    expect(tagging[type], `no tag permission mapped for ${type}`).toBeDefined()
    expect(allows(...tagging[type]!), type).toBe(true)
  }
}, 20_000)

test('no_nat_waf_or_vpc_endpoints', () => {
  const types = Object.values(synth().json.Resources).map(resource => resource.Type)
  for (const type of types) expect(type).not.toMatch(/^AWS::(EC2|WAFv2|WAF|WAFRegional|NetworkFirewall)::/)
  for (const fn of ofType(synth().json, 'AWS::Lambda::Function')) expect(fn[1].Properties!.VpcConfig).toBeUndefined()
}, 20_000)

describe('removal_policies_match_decision', () => {
  test('every pilot resource is deleted with the stack, without PITR or deletion protection', () => {
    const { json } = synth()
    for (const [id, resource] of Object.entries(json.Resources)) {
      expect(resource.DeletionPolicy ?? 'Delete', id).toBe('Delete')
      expect(resource.UpdateReplacePolicy ?? 'Delete', id).toBe('Delete')
    }
    const [[, table]] = ofType(json, 'AWS::DynamoDB::Table') as [[string, Resource]]
    expect(table.Properties).toMatchObject({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false }, DeletionProtectionEnabled: false })
    const [[, pool]] = ofType(json, 'AWS::Cognito::UserPool') as [[string, Resource]]
    expect(pool.Properties!.DeletionProtection ?? 'INACTIVE').toBe('INACTIVE')
    // The web bucket is emptied by hand (runbook): no auto-delete custom resource or extra role.
    const [[, bucket]] = ofType(json, 'AWS::S3::Bucket') as [[string, Resource]]
    expect(bucket.DeletionPolicy).toBe('Delete')
    expect(JSON.stringify(json)).not.toContain('Custom::S3AutoDeleteObjects')
    for (const [, queue] of ofType(json, 'AWS::SQS::Queue')) expect(queue.Properties!.MessageRetentionPeriod).toBe(14 * 86_400)
  }, 20_000)

  test('the foundation retains only the artifact bucket and owns the budget and the operator policy', () => {
    const { json } = synthFoundation()
    const retained = Object.entries(json.Resources).filter(([, resource]) => resource.DeletionPolicy === 'Retain').map(([, r]) => r.Type)
    expect(retained).toEqual(['AWS::S3::Bucket'])
  })
})

describe('dynamodb_on_demand_throughput_is_bounded', () => {
  test('the table caps on-demand reads and writes above the expected peak', () => {
    const { json } = synth()
    const [[, table]] = ofType(json, 'AWS::DynamoDB::Table') as [[string, Resource]]
    expect(table.Properties).toMatchObject({ BillingMode: 'PAY_PER_REQUEST',
      OnDemandThroughput: { MaxReadRequestUnits: TABLE_LIMITS.maxReadRequestUnits, MaxWriteRequestUnits: TABLE_LIMITS.maxWriteRequestUnits } })
    expect(TABLE_LIMITS.maxReadRequestUnits).toBeGreaterThanOrEqual(2 * TABLE_LIMITS.expectedPeakReadUnits)
    expect(TABLE_LIMITS.maxWriteRequestUnits).toBeGreaterThanOrEqual(2 * TABLE_LIMITS.expectedPeakWriteUnits)
    expect(() => checkTableLimits({ ...TABLE_LIMITS, maxReadRequestUnits: TABLE_LIMITS.expectedPeakReadUnits })).toThrow(/headroom/)
    expect(() => checkTableLimits({ ...TABLE_LIMITS, maxWriteRequestUnits: 0 })).toThrow(/at least 1/)
  }, 20_000)
})

describe('foundation_permissions_cover_observability_within_arturia', () => {
  const cfn = rolePolicies(target).cloudformation
  const has = (action: string, resource: string) => cfn.some(s => s.Action.includes(action) &&
    s.Resource.some(pattern => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(resource)))

  test('the cloudformation role manages only arturia log groups, alarms and the alerts topic', () => {
    const logs = 'arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/arturia-pilot-worker'
    for (const action of ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:TagResource']) {
      expect(has(action, logs), action).toBe(true)
      expect(has(action, 'arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/other-project'), action).toBe(false)
    }
    expect(has('logs:CreateLogGroup', `arn:aws:logs:us-east-1:111111111111:log-group:${NAMES.accessLogGroup}`)).toBe(true)
    const alarm = 'arn:aws:cloudwatch:us-east-1:111111111111:alarm:arturia-pilot-turns-dlq-visible'
    for (const action of ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:TagResource']) {
      expect(has(action, alarm), action).toBe(true)
      expect(has(action, 'arn:aws:cloudwatch:us-east-1:111111111111:alarm:billing'), action).toBe(false)
    }
    const topic = `arn:aws:sns:us-east-1:111111111111:${NAMES.alertsTopic}`
    for (const action of ['sns:CreateTopic', 'sns:DeleteTopic', 'sns:Subscribe', 'sns:TagResource']) {
      expect(has(action, topic), action).toBe(true)
      expect(has(action, 'arn:aws:sns:us-east-1:111111111111:other-topic'), action).toBe(false)
    }
    expect(has('sns:Unsubscribe', `${topic}:0f1e2d3c`)).toBe(true)
    // Actions listed by the published CloudFormation handler schemas of the new resource types.
    for (const action of ['logs:TagLogGroup', 'logs:UntagLogGroup', 'logs:ListTagsLogGroup', 'logs:DeleteDataProtectionPolicy',
      'logs:GetDataProtectionPolicy', 'logs:DeleteRetentionPolicy']) expect(has(action, logs), action).toBe(true)
    expect(has('sns:GetDataProtectionPolicy', topic)).toBe(true)
    expect(has('lambda:TagResource', 'arn:aws:lambda:us-east-1:111111111111:event-source-mapping:abc')).toBe(true)
    // No budgets, no sns:Publish, no IAM beyond the existing PassRole, no invalidations.
    const actions = cfn.flatMap(s => s.Action)
    expect(actions.some(a => a.startsWith('budgets:'))).toBe(false)
    expect(actions).not.toContain('sns:Publish')
    expect(actions.filter(a => a.startsWith('iam:'))).toEqual(['iam:PassRole'])
  })

  test('the boundary caps the new services by arturia names and stays under the managed policy limit', () => {
    const boundary = boundaryPolicy(target)
    const text = JSON.stringify(boundary)
    // IAM counts managed policy size without whitespace: 6,144 characters.
    expect(text.length).toBeLessThan(6_144)
    const ceiling = (boundary as unknown as { Statement: Statement[] }).Statement
    const cloudwatch = ceiling.find(s => s.Action.includes('cloudwatch:*'))
    expect(cloudwatch?.Resource).toEqual(['arn:aws:cloudwatch:us-east-1:111111111111:alarm:arturia-pilot-*'])
    const sns = ceiling.find(s => s.Action.includes('sns:*'))
    expect(sns?.Resource).toEqual(['arn:aws:sns:us-east-1:111111111111:arturia-pilot-*'])
    expect(ceiling.some(s => s.Action.some(a => a.startsWith('budgets:')))).toBe(false)
  })

  test('the operator policy is one managed policy scoped to arturia, under the size limit and without IAM writes', () => {
    const document = operatorManagedPolicy(target) as unknown as { Statement: Statement[] }
    expect(JSON.stringify(document).length).toBeLessThan(6_144)
    const actions = document.Statement.flatMap(s => s.Action)
    for (const action of ['dynamodb:PutItem', 'sqs:StartMessageMoveTask', 'cognito-idp:AdminCreateUser', 's3:DeleteObject',
      'logs:StartQuery', 'cloudwatch:SetAlarmState', 'budgets:ViewBudget']) expect(actions, action).toContain(action)
    expect(actions.filter(a => a.startsWith('iam:'))).toEqual(['iam:PassRole'])
    for (const forbidden of ['dynamodb:DeleteTable', 'dynamodb:Scan', 'sqs:DeleteQueue', 'budgets:ModifyBudget', 'ce:UpdateCostAllocationTagsStatus',
      'sso:UpdatePermissionSet', 'cognito-idp:DeleteUserPool']) expect(actions, forbidden).not.toContain(forbidden)
    const cognito = document.Statement.find(s => s.Action.includes('cognito-idp:AdminCreateUser'))
    expect(cognito?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/Project': 'arturia', 'aws:ResourceTag/Environment': 'pilot' } })
    for (const statement of document.Statement) {
      for (const resource of statement.Resource) {
        if (resource === '*') {
          for (const action of statement.Action) expect(['logs:GetQueryResults', 'logs:StopQuery', 'logs:DescribeLogGroups',
            'cloudwatch:GetMetricData'], action).toContain(action)
          expect(statement.Condition?.StringEquals?.['aws:RequestedRegion']).toBe('us-east-1')
        } else if (resource.endsWith(':userpool/*')) {
          // Pool IDs are assigned at creation: the App tags scope the Cognito administration.
          expect(statement.Condition?.StringEquals?.['aws:ResourceTag/Project'], resource).toBe('arturia')
        } else {
          expect(resource, resource).toMatch(/arturia/)
        }
      }
    }
    const { json } = synthFoundation()
    const operators = (ofType(json, 'AWS::IAM::ManagedPolicy') as [string, Resource][])
      .filter(([, policy]) => policy.Properties?.ManagedPolicyName === OPERATOR_POLICY_NAME)
    expect(operators).toHaveLength(1)
    const [[, managed]] = operators as [[string, Resource]]
    // The foundation defines the policy; attaching it to the Architect permission set is an A1 administrative step.
    for (const key of ['Roles', 'Users', 'Groups']) expect(managed.Properties![key]).toBeUndefined()
  })
})
