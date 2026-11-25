// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Delivery model for the pilot: fixed names and the minimal permissions of every predefined role.
// The privileged foundation creates these roles under an external permissions boundary. The pilot
// stack only imports them and creates no IAM. No account ID lives here: every ARN is built from a
// target, either CloudFormation pseudo parameters or values supplied by the operator.

import { HTTP_TABLE_ACTIONS } from './chat-api.ts'
import { WORKER_TABLE_ACTIONS } from './worker.ts'

/** One rolldown entry per Lambda handler. Output: `<outdir>/<name>/index.cjs`. */
export const BUNDLES = {
  stream: 'src/chat/stream.lambda.ts',
  relay: 'src/jobs/outbox.worker.ts',
  http: 'src/http/turns.lambda.ts',
  worker: 'src/chat/generate.lambda.ts',
} as const
export type BundleName = keyof typeof BUNDLES

export const STACKS = {
  foundation: 'arturia-foundation',
  pilot: 'arturia-pilot',
  synthetic: 'arturia-pilot-synthetic',
} as const
/** Placeholders resolved by the CDK synthesizer or by CloudFormation. */
export const ARTIFACT_BUCKET = 'arturia-artifacts-${AWS::AccountId}-${AWS::Region}'
/** Private bucket of the web client, readable only by CloudFront. Predictable so the foundation can scope its roles. */
export const WEB_BUCKET = 'arturia-pilot-web-${AWS::AccountId}-${AWS::Region}'
export const ARTIFACT_PREFIX = `${STACKS.pilot}/`
/** Reserved, never valid for deployment: the test synthesis cannot target a real account. */
export const SYNTHETIC_ACCOUNT = '000000000000'

const P = `${STACKS.pilot}-`
export const NAMES = {
  streamFunction: `${P}stream`,
  httpFunction: `${P}http`,
  relayFunction: `${P}relay`,
  workerFunction: `${P}worker`,
  table: `${P}chat`,
  /** AI consumption ledger: retained table of the foundation, so recreating the pilot cannot reset the monthly budget. */
  ledgerTable: `${P}ledger`,
  /** The one secret with the provider keys, created by the administrator (never by CloudFormation) with the console or a file. */
  providerSecret: 'arturia-pilot/providers',
  turnQueue: `${P}turns.fifo`,
  turnDeadLetters: `${P}turns-dlq.fifo`,
  relayDeadLetters: `${P}relay-dlq`,
  // Web hosting. The publisher is the custom resource Lambda that copies the web build and config.json to the bucket.
  publisherFunction: `${P}publisher`,
  publisherLayer: `${P}awscli`,
  rewriteFunction: `${P}spa-rewrite`,
  webCachePolicy: `${P}web`,
  webHeaders: `${P}web`,
  configHeaders: `${P}config`,
  // Observability. CloudWatch metrics of REST APIs use the API name as a dimension.
  restApi: `${P}api`,
  alertsTopic: `${P}alerts`,
  accessLogGroup: `${P}api-access`,
} as const

/** Account-level monthly budget owned by the foundation (D4). */
export const BUDGET_NAME = 'arturia-aws-monthly'
/** Customer managed policy for the Architect permission set; attaching it is an administrative step (A1). */
export const OPERATOR_POLICY_NAME = `${P}operator`
/** Customer managed policy of the foundation with the CloudFormation role's hosting and observability permissions. */
export const HOSTING_POLICY_NAME = `${P}cloudformation-hosting`

/** Roles created by the foundation. */
export const ROLE_NAMES = ['stream', 'relay', 'worker', 'http', 'publisher', 'cloudformation'] as const
export type RoleName = (typeof ROLE_NAMES)[number]
export const BOUNDARY_NAME = `${P}boundary`

export interface Target { readonly partition: string; readonly account: string; readonly region: string }
type Condition = Record<string, Record<string, string | string[]>>
export interface Statement { Effect: 'Allow' | 'Deny'; Action: string[]; Resource: string[]; Condition?: Condition }

export const allow = (Action: string[], Resource: string[], Condition?: Condition): Statement =>
  ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) })
export const deny = (Action: string[], Resource: string[]): Statement => ({ Effect: 'Deny', Action, Resource })
export const policy = (Statement: readonly unknown[]) => ({ Version: '2012-10-17', Statement })
const trust = (Service: string) =>
  policy([{ Effect: 'Allow', Principal: { Service }, Action: 'sts:AssumeRole' }])

export const roleArn = (t: Target, name: RoleName) => `arn:${t.partition}:iam::${t.account}:role/${P}${name}`
export const boundaryArn = (t: Target) => `arn:${t.partition}:iam::${t.account}:policy/${BOUNDARY_NAME}`
const resolveBucket = (template: string, t: Target) =>
  template.replace('${AWS::AccountId}', t.account).replace('${AWS::Region}', t.region)
export const bucketName = (t: Target) => resolveBucket(ARTIFACT_BUCKET, t)
export const webBucketName = (t: Target) => resolveBucket(WEB_BUCKET, t)

function arns(t: Target) {
  const regional = (service: string, resource: string) => `arn:${t.partition}:${service}:${t.region}:${t.account}:${resource}`
  const table = regional('dynamodb', `table/${NAMES.table}`)
  const ledger = regional('dynamodb', `table/${NAMES.ledgerTable}`)
  const fn = (name: string) => regional('lambda', `function:${name}`)
  const logs = (name: string) => regional('logs', `log-group:/aws/lambda/${name}:*`)
  const topic = regional('sns', NAMES.alertsTopic)
  return {
    table, ledger, tableStream: `${table}/stream/*`, fn, logs,
    // Secrets Manager appends a dash and six random characters to the name: the pattern pins the name and nothing else.
    providerSecret: regional('secretsmanager', `secret:${NAMES.providerSecret}-??????`),
    // Function log groups and the access log group, with and without the log stream suffix.
    logGroups: [`log-group:/aws/lambda/${P}*`, `log-group:${P}*`].map(group => regional('logs', group)),
    alarms: regional('cloudwatch', `alarm:${P}*`),
    topic, subscriptions: `${topic}:*`,
    apiTags: `arn:${t.partition}:apigateway:${t.region}::/tags/*`,
    budget: `arn:${t.partition}:budgets::${t.account}:budget/${BUDGET_NAME}`,
    queue: (name: string) => regional('sqs', name),
    userPools: regional('cognito-idp', 'userpool/*'),
    eventSourceMappings: regional('lambda', 'event-source-mapping:*'),
    restApis: `arn:${t.partition}:apigateway:${t.region}::/restapis`,
    bucket: `arn:${t.partition}:s3:::${bucketName(t)}`,
    artifacts: `arn:${t.partition}:s3:::${bucketName(t)}/${ARTIFACT_PREFIX}*`,
    webBucket: `arn:${t.partition}:s3:::${webBucketName(t)}`,
    layer: regional('lambda', `layer:${NAMES.publisherLayer}`),
    // CloudFront is global: its ARNs carry the account but no region.
    cloudfront: (resource: string) => `arn:${t.partition}:cloudfront::${t.account}:${resource}`,
    pilotStack: regional('cloudformation', `stack/${STACKS.pilot}/*`),
  }
}

const sameRegion = (t: Target): Condition => ({ StringEquals: { 'aws:RequestedRegion': t.region } })
const passTo = (service: string): Condition => ({ StringEquals: { 'iam:PassedToService': service } })

/** Minimal permissions of each predefined role. */
export function rolePolicies(t: Target): Record<RoleName, Statement[]> {
  const a = arns(t)
  const cfn = cloudformationPolicies(t)
  const sendTo = (queue: string) =>
    allow(['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'], [a.queue(queue)])
  return {
    stream: [
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [a.logs(NAMES.streamFunction)]),
      allow(['dynamodb:GetItem', 'dynamodb:Query'], [a.table]),
    ],
    relay: [
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [a.logs(NAMES.relayFunction)]),
      allow(['dynamodb:GetItem', 'dynamodb:UpdateItem'], [a.table], {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'OUTBOX#*' },
        Null: { 'dynamodb:LeadingKeys': 'false' },
      }),
      allow(['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'], [a.tableStream]),
      // The stream event source lists streams before reading; ListStreams has no resource type.
      allow(['dynamodb:ListStreams'], ['*'], sameRegion(t)),
      sendTo(NAMES.turnQueue),
      sendTo(NAMES.relayDeadLetters),
    ],
    worker: [
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [a.logs(NAMES.workerFunction)]),
      allow([...WORKER_TABLE_ACTIONS], [a.table, a.ledger]),
      // The provider keys: read one secret, nothing else. The managed `aws/secretsmanager` key needs no KMS grant.
      allow(['secretsmanager:GetSecretValue'], [a.providerSecret]),
      // The SQS event source polls with the function role.
      allow(['sqs:ReceiveMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueUrl', 'sqs:DeleteMessage',
        'sqs:GetQueueAttributes'], [a.queue(NAMES.turnQueue)]),
    ],
    // REST proxy handler: transactional writes and reads of the chat table only.
    http: [
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [a.logs(NAMES.httpFunction)]),
      allow([...HTTP_TABLE_ACTIONS], [a.table]),
    ],
    // BucketDeployment handler: reads the staged web sources and syncs them into the web bucket. Pruning a
    // deployment's own scope needs DeleteObject; no bucket configuration, ACL or CloudFront invalidation.
    publisher: [
      allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [a.logs(NAMES.publisherFunction)]),
      allow(['s3:GetObject'], [a.artifacts]),
      allow(['s3:ListBucket'], [a.webBucket]),
      allow(['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], [`${a.webBucket}/*`]),
    ],
    cloudformation: [...cfn.inline, ...cfn.hosting],
  }
}

/**
 * Permissions of the CloudFormation role, checked against the registry handlers of every pilot resource type (A0).
 * Web hosting and observability live in a customer managed policy of the foundation attached to the role
 * ({@link HOSTING_POLICY_NAME}), because the inline policy alone exceeds 10,240 characters with the longest ARNs.
 * The union is unchanged by the split: both documents only allow.
 */
export function cloudformationPolicies(t: Target): { inline: Statement[]; hosting: Statement[] } {
  const a = arns(t)
  const queues = [NAMES.turnQueue, NAMES.turnDeadLetters, NAMES.relayDeadLetters].map(a.queue)
  const functions = [a.fn(NAMES.streamFunction), a.fn(NAMES.relayFunction), a.fn(NAMES.workerFunction), a.fn(NAMES.httpFunction),
    a.fn(NAMES.publisherFunction)]
  const consumers = [a.fn(NAMES.relayFunction), a.fn(NAMES.workerFunction)]
  return {
    inline: [
      allow(['s3:GetObject'], [a.artifacts]),
      // No resource-level permissions. The function delete handler reads network interfaces so a delete or
      // rollback does not end in DELETE_FAILED (A0, Goldfish).
      allow(['cognito-idp:CreateUserPool', 'cognito-idp:DescribeUserPoolDomain', 'ec2:DescribeNetworkInterfaces'], ['*'],
        sameRegion(t)),
      allow([
        'cognito-idp:DescribeUserPool', 'cognito-idp:UpdateUserPool', 'cognito-idp:DeleteUserPool',
        'cognito-idp:GetUserPoolMfaConfig', 'cognito-idp:SetUserPoolMfaConfig',
        'cognito-idp:CreateUserPoolClient', 'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:UpdateUserPoolClient', 'cognito-idp:DeleteUserPoolClient',
        'cognito-idp:CreateUserPoolDomain', 'cognito-idp:UpdateUserPoolDomain', 'cognito-idp:DeleteUserPoolDomain',
        'cognito-idp:CreateResourceServer', 'cognito-idp:DescribeResourceServer',
        'cognito-idp:UpdateResourceServer', 'cognito-idp:DeleteResourceServer',
        'cognito-idp:TagResource', 'cognito-idp:UntagResource', 'cognito-idp:ListTagsForResource',
        // Read handler of AWS::Cognito::UserPoolClient (A0); the clients have no secret.
        'cognito-idp:ListUserPoolClientSecrets',
      ], [a.userPools]),
      allow(['apigateway:POST'], [a.restApis]),
      allow(['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
        [`${a.restApis}/*`]),
      allow([
        'dynamodb:CreateTable', 'dynamodb:DescribeTable', 'dynamodb:UpdateTable', 'dynamodb:DeleteTable',
        'dynamodb:DescribeContinuousBackups', 'dynamodb:UpdateContinuousBackups',
        'dynamodb:DescribeTimeToLive', 'dynamodb:TagResource', 'dynamodb:UntagResource', 'dynamodb:ListTagsOfResource',
        // Read handler of AWS::DynamoDB::Table (A0).
        'dynamodb:DescribeContributorInsights', 'dynamodb:DescribeKinesisStreamingDestination', 'dynamodb:GetResourcePolicy',
      ], [a.table]),
      allow([
        'sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes',
        'sqs:GetQueueUrl', 'sqs:TagQueue', 'sqs:UntagQueue', 'sqs:ListQueueTags',
      ], queues),
      allow([
        'lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
        'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration',
        'lambda:GetFunctionCodeSigningConfig', 'lambda:GetRuntimeManagementConfig', 'lambda:GetFunctionRecursionConfig',
        'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency', 'lambda:GetPolicy',
        'lambda:TagResource', 'lambda:UntagResource', 'lambda:ListTags',
        // Read handler of AWS::Lambda::Function (A0).
        'lambda:GetFunctionScalingConfig',
      ], functions),
      allow(['lambda:AddPermission', 'lambda:RemovePermission'], functions,
        { StringEquals: { 'lambda:Principal': 'apigateway.amazonaws.com' } }),
      // CreateEventSourceMapping has no resource type: only the function condition can scope it.
      allow(['lambda:CreateEventSourceMapping'], ['*'],
        { StringEquals: { 'lambda:FunctionArn': consumers, 'aws:RequestedRegion': t.region } }),
      allow(['lambda:UpdateEventSourceMapping', 'lambda:DeleteEventSourceMapping'],
        [a.eventSourceMappings], { StringEquals: { 'lambda:FunctionArn': consumers } }),
      allow(['lambda:GetEventSourceMapping'], [a.eventSourceMappings]),
      // The publisher is a custom resource: CloudFormation invokes it and creates its AWS CLI layer.
      allow(['lambda:InvokeFunction'], [a.fn(NAMES.publisherFunction)]),
      allow(['lambda:PublishLayerVersion'], [a.layer]),
      allow(['lambda:GetLayerVersion', 'lambda:DeleteLayerVersion'], [`${a.layer}:*`]),
      allow(['iam:PassRole'], [roleArn(t, 'stream'), roleArn(t, 'relay'), roleArn(t, 'worker'), roleArn(t, 'http'),
        roleArn(t, 'publisher')], passTo('lambda.amazonaws.com')),
      // Tags of the App (Project, Environment) on event source mappings and on the API and its stage.
      allow(['lambda:TagResource', 'lambda:UntagResource', 'lambda:ListTags'], [a.eventSourceMappings]),
      allow(['apigateway:GET', 'apigateway:PUT', 'apigateway:DELETE'], [a.apiTags]),
    ],
    hosting: [
      // Web bucket configuration only: objects are written by the publisher, never by CloudFormation.
      allow([
        's3:CreateBucket', 's3:DeleteBucket', 's3:ListBucket', 's3:GetBucketLocation',
        's3:PutBucketPublicAccessBlock', 's3:GetBucketPublicAccessBlock', 's3:PutEncryptionConfiguration',
        's3:GetEncryptionConfiguration', 's3:PutBucketOwnershipControls', 's3:GetBucketOwnershipControls',
        's3:PutBucketTagging', 's3:GetBucketTagging', 's3:PutBucketPolicy', 's3:GetBucketPolicy', 's3:DeleteBucketPolicy',
        // Read and create handlers of AWS::S3::Bucket (A0): configuration reads and the schema's tag actions.
        's3:GetBucketAcl', 's3:GetBucketCORS', 's3:GetBucketVersioning', 's3:GetBucketWebsite', 's3:GetBucketLogging',
        's3:GetBucketNotification', 's3:GetBucketObjectLockConfiguration', 's3:GetBucketAbac', 's3:GetBucketDefaultStorageClass',
        's3:GetBucketMetadataTableConfiguration', 's3:GetAccelerateConfiguration', 's3:GetAnalyticsConfiguration',
        's3:GetIntelligentTieringConfiguration', 's3:GetInventoryConfiguration', 's3:GetLifecycleConfiguration',
        's3:GetMetricsConfiguration', 's3:GetReplicationConfiguration', 's3:TagResource', 's3:UntagResource',
        's3:ListTagsForResource',
      ], [a.webBucket]),
      // Distribution, OAC, cache and header policy IDs are assigned by CloudFront, so only the type can be scoped.
      allow([
        'cloudfront:CreateDistribution', 'cloudfront:CreateDistributionWithTags', 'cloudfront:GetDistribution',
        'cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution', 'cloudfront:DeleteDistribution',
        'cloudfront:TagResource', 'cloudfront:UntagResource', 'cloudfront:ListTagsForResource',
      ], [a.cloudfront('distribution/*')]),
      allow([
        'cloudfront:CreateFunction', 'cloudfront:DescribeFunction', 'cloudfront:GetFunction', 'cloudfront:UpdateFunction',
        'cloudfront:PublishFunction', 'cloudfront:DeleteFunction',
        'cloudfront:TagResource', 'cloudfront:UntagResource', 'cloudfront:ListTagsForResource',
      ], [a.cloudfront(`function/${NAMES.rewriteFunction}`)]),
      allow([
        'cloudfront:CreateOriginAccessControl', 'cloudfront:GetOriginAccessControl', 'cloudfront:GetOriginAccessControlConfig',
        'cloudfront:UpdateOriginAccessControl', 'cloudfront:DeleteOriginAccessControl',
      ], [a.cloudfront('origin-access-control/*')]),
      allow([
        'cloudfront:CreateCachePolicy', 'cloudfront:GetCachePolicy', 'cloudfront:GetCachePolicyConfig',
        'cloudfront:UpdateCachePolicy', 'cloudfront:DeleteCachePolicy',
      ], [a.cloudfront('cache-policy/*')]),
      allow([
        'cloudfront:CreateResponseHeadersPolicy', 'cloudfront:GetResponseHeadersPolicy',
        'cloudfront:GetResponseHeadersPolicyConfig', 'cloudfront:UpdateResponseHeadersPolicy',
        'cloudfront:DeleteResponseHeadersPolicy',
      ], [a.cloudfront('response-headers-policy/*')]),
      // Observability (13.8): explicit log groups, alarms and the alerts topic, all under arturia-pilot-* names.
      allow([
        'logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy',
        'logs:TagResource', 'logs:UntagResource', 'logs:ListTagsForResource', 'logs:GetDataProtectionPolicy',
        // Legacy tag actions and the data protection cleanup listed by the AWS::Logs::LogGroup handlers.
        'logs:TagLogGroup', 'logs:UntagLogGroup', 'logs:ListTagsLogGroup', 'logs:DeleteDataProtectionPolicy',
      ], a.logGroups),
      // No resource type: read-only metadata, region bound. The index and resource policy reads come from the
      // AWS::Logs::LogGroup read handler (A0).
      allow(['logs:DescribeLogGroups', 'logs:DescribeIndexPolicies', 'logs:DescribeResourcePolicies'], ['*'], sameRegion(t)),
      allow([
        'cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms',
        'cloudwatch:TagResource', 'cloudwatch:UntagResource', 'cloudwatch:ListTagsForResource',
      ], [a.alarms]),
      allow([
        'sns:CreateTopic', 'sns:DeleteTopic', 'sns:GetTopicAttributes', 'sns:SetTopicAttributes', 'sns:Subscribe',
        'sns:ListSubscriptionsByTopic', 'sns:TagResource', 'sns:UntagResource', 'sns:ListTagsForResource',
        // The AWS::SNS::Topic read handler reads the data protection policy.
        'sns:GetDataProtectionPolicy',
      ], [a.topic]),
      allow(['sns:Unsubscribe', 'sns:GetSubscriptionAttributes', 'sns:SetSubscriptionAttributes'], [a.subscriptions]),
    ],
  }
}

export const roleTrust = (name: RoleName) =>
  trust(name === 'cloudformation' ? 'cloudformation.amazonaws.com' : 'lambda.amazonaws.com')

/**
 * External permissions boundary, created by the administrator before the foundation. It caps every
 * predefined role per service and `arturia-pilot-*` names, so role changes within those services
 * do not require rewriting it.
 */
export function boundaryPolicy(t: Target) {
  const regional = (service: string, resource: string) => `arn:${t.partition}:${service}:${t.region}:${t.account}:${resource}`
  const named = `${P}*`
  return policy([
    allow(['logs:*'], [regional('logs', `log-group:/aws/lambda/${named}`), regional('logs', `log-group:${named}`)]),
    allow(['cloudwatch:*'], [regional('cloudwatch', `alarm:${named}`)]),
    allow(['sns:*'], [regional('sns', named)]),
    allow(['dynamodb:*'], [regional('dynamodb', `table/${named}`)]),
    allow(['sqs:*'], [regional('sqs', named)]),
    allow(['lambda:*'], [regional('lambda', `function:${named}`), regional('lambda', 'event-source-mapping:*'),
      regional('lambda', `layer:${named}`), regional('lambda', `layer:${named}:*`)]),
    allow(['cognito-idp:*'], [regional('cognito-idp', 'userpool/*')]),
    allow(['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
      [`arn:${t.partition}:apigateway:${t.region}::/restapis`, `arn:${t.partition}:apigateway:${t.region}::/restapis/*`,
        `arn:${t.partition}:apigateway:${t.region}::/tags/*`]),
    allow(['s3:GetObject'], [`arn:${t.partition}:s3:::${bucketName(t)}/${ARTIFACT_PREFIX}*`]),
    allow(['s3:*'], [`arn:${t.partition}:s3:::${webBucketName(t)}`, `arn:${t.partition}:s3:::${webBucketName(t)}/*`]),
    allow(['cloudfront:*'], ['distribution/*', `function/${named}`, 'origin-access-control/*', 'cache-policy/*',
      'response-headers-policy/*'].map(resource => `arn:${t.partition}:cloudfront::${t.account}:${resource}`)),
    allow(['dynamodb:ListStreams', 'cognito-idp:CreateUserPool', 'cognito-idp:DescribeUserPoolDomain',
      'lambda:CreateEventSourceMapping', 'logs:DescribeLogGroups', 'logs:DescribeIndexPolicies', 'logs:DescribeResourcePolicies',
      'ec2:DescribeNetworkInterfaces'], ['*'], sameRegion(t)),
    allow(['secretsmanager:GetSecretValue'], [arns(t).providerSecret]),
    allow(['iam:PassRole'], [`arn:${t.partition}:iam::${t.account}:role/${named}`]),
  ])
}

/** Permissions of the principal that deploys the pilot. The foundation does not create it. */
export function operatorPolicy(t: Target) {
  const a = arns(t)
  const cfn = roleArn(t, 'cloudformation')
  return policy([
    allow(['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeChangeSet',
      'cloudformation:GetTemplate', 'cloudformation:GetTemplateSummary', 'cloudformation:ListStackResources'], [a.pilotStack]),
    // Import change sets could adopt resources of other projects into the pilot stack.
    allow(['cloudformation:CreateChangeSet'], [a.pilotStack], {
      StringEquals: { 'cloudformation:RoleArn': cfn }, Null: { 'cloudformation:ImportResourceTypes': 'true' },
    }),
    allow(['cloudformation:DeleteStack'], [a.pilotStack], { StringEquals: { 'cloudformation:RoleArn': cfn } }),
    allow(['cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet'], [a.pilotStack]),
    allow(['iam:PassRole'], [cfn], passTo('cloudformation.amazonaws.com')),
    allow(['s3:GetObject', 's3:PutObject'], [a.artifacts]),
    allow(['s3:ListBucket', 's3:GetBucketLocation', 's3:GetEncryptionConfiguration'], [a.bucket]),
    // Confirms the provider secret exists before the billable mode is deployed. It cannot read the value.
    allow(['secretsmanager:DescribeSecret'], [a.providerSecret]),
  ])
}

/**
 * Operations on the pilot's data and observability, for the runbook procedures (provisioning, outbox
 * republication, DLQ inspection and redrive, sign-out and disabling users, emptying the web bucket before
 * deleting the stack, reading logs, alarms and the budget). Every resource is an Arturia name; the few
 * actions without a resource type are read-only and region bound.
 */
export function operationsPolicy(t: Target) {
  const a = arns(t)
  const [turns, turnsDlq, relayDlq] = [NAMES.turnQueue, NAMES.turnDeadLetters, NAMES.relayDeadLetters].map(a.queue)
  return policy([
    allow(['dynamodb:DescribeTable', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem'], [a.table]),
    // Reconciliation of uncertain reservations: items and Query on the ledger partition; never Scan or Delete.
    allow(['dynamodb:DescribeTable', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
      'dynamodb:ConditionCheckItem'], [a.ledger]),
    allow(['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'], [turns]),
    allow(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:StartMessageMoveTask',
      'sqs:ListMessageMoveTasks', 'sqs:CancelMessageMoveTask'], [turnsDlq]),
    allow(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:PurgeQueue', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'], [relayDlq]),
    // The pool ID is assigned at creation: scope by the App tags instead.
    allow(['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminUserGlobalSignOut',
      'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDeleteUser'], [a.userPools],
    { StringEquals: { 'aws:ResourceTag/Project': 'arturia', 'aws:ResourceTag/Environment': 'pilot' } }),
    allow(['s3:ListBucket'], [a.webBucket]),
    allow(['s3:DeleteObject'], [`${a.webBucket}/*`]),
    allow(['logs:FilterLogEvents', 'logs:GetLogEvents', 'logs:DescribeLogStreams', 'logs:StartQuery'], a.logGroups),
    allow(['logs:GetQueryResults', 'logs:StopQuery', 'logs:DescribeLogGroups', 'cloudwatch:GetMetricData'], ['*'], sameRegion(t)),
    allow(['cloudwatch:DescribeAlarms', 'cloudwatch:SetAlarmState'], [a.alarms]),
    allow(['budgets:ViewBudget'], [a.budget]),
  ])
}

/**
 * Explicit denials of the operator. The account-wide Architect policy allows `dynamodb:*` and secret access on any
 * resource, and an explicit deny wins over any allow. They keep two promises: nobody but the worker reads or writes
 * the provider key, and the AI ledger cannot be emptied or reconfigured with the daily profile (D3). The operator
 * keeps `DescribeSecret` and the item-level access that settlement needs. Changing either takes the administrator.
 */
export function operatorDenials(t: Target) {
  const a = arns(t)
  return policy([
    deny(['secretsmanager:GetSecretValue', 'secretsmanager:BatchGetSecretValue', 'secretsmanager:PutSecretValue',
      'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:RestoreSecret', 'secretsmanager:RotateSecret',
      'secretsmanager:UpdateSecretVersionStage', 'secretsmanager:PutResourcePolicy', 'secretsmanager:DeleteResourcePolicy',
      'secretsmanager:ReplicateSecretToRegions'], [a.providerSecret]),
    deny(['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteTable', 'dynamodb:UpdateTable',
      'dynamodb:UpdateContinuousBackups', 'dynamodb:UpdateTimeToLive', 'dynamodb:PutResourcePolicy',
      'dynamodb:DeleteResourcePolicy', 'dynamodb:PartiQLDelete', 'dynamodb:PartiQLUpdate', 'dynamodb:PartiQLInsert',
      'dynamodb:ImportTable', 'dynamodb:RestoreTableFromAwsBackup'], [a.ledger]),
  ])
}

/** One customer managed policy: deployment, operations and denials. IAM limits managed policies to 6,144 characters. */
export const operatorManagedPolicy = (t: Target) =>
  policy([...operatorPolicy(t).Statement, ...operationsPolicy(t).Statement, ...operatorDenials(t).Statement])
