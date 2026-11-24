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
} as const

/** Roles created by the foundation. */
export const ROLE_NAMES = ['stream', 'relay', 'worker', 'http', 'publisher', 'cloudformation'] as const
export type RoleName = (typeof ROLE_NAMES)[number]
export const BOUNDARY_NAME = `${P}boundary`

export interface Target { readonly partition: string; readonly account: string; readonly region: string }
type Condition = Record<string, Record<string, string | string[]>>
export interface Statement { Effect: 'Allow'; Action: string[]; Resource: string[]; Condition?: Condition }

export const allow = (Action: string[], Resource: string[], Condition?: Condition): Statement =>
  ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) })
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
  const fn = (name: string) => regional('lambda', `function:${name}`)
  const logs = (name: string) => regional('logs', `log-group:/aws/lambda/${name}:*`)
  return {
    table, tableStream: `${table}/stream/*`, fn, logs,
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
  const queues = [NAMES.turnQueue, NAMES.turnDeadLetters, NAMES.relayDeadLetters].map(a.queue)
  const functions = [a.fn(NAMES.streamFunction), a.fn(NAMES.relayFunction), a.fn(NAMES.workerFunction), a.fn(NAMES.httpFunction),
    a.fn(NAMES.publisherFunction)]
  const consumers = [a.fn(NAMES.relayFunction), a.fn(NAMES.workerFunction)]
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
      allow([...WORKER_TABLE_ACTIONS], [a.table]),
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
    cloudformation: [
      allow(['s3:GetObject'], [a.artifacts]),
      // Neither action supports resource-level permissions.
      allow(['cognito-idp:CreateUserPool', 'cognito-idp:DescribeUserPoolDomain'], ['*'], sameRegion(t)),
      allow([
        'cognito-idp:DescribeUserPool', 'cognito-idp:UpdateUserPool', 'cognito-idp:DeleteUserPool',
        'cognito-idp:GetUserPoolMfaConfig', 'cognito-idp:SetUserPoolMfaConfig',
        'cognito-idp:CreateUserPoolClient', 'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:UpdateUserPoolClient', 'cognito-idp:DeleteUserPoolClient',
        'cognito-idp:CreateUserPoolDomain', 'cognito-idp:UpdateUserPoolDomain', 'cognito-idp:DeleteUserPoolDomain',
        'cognito-idp:CreateResourceServer', 'cognito-idp:DescribeResourceServer',
        'cognito-idp:UpdateResourceServer', 'cognito-idp:DeleteResourceServer',
        'cognito-idp:TagResource', 'cognito-idp:UntagResource', 'cognito-idp:ListTagsForResource',
      ], [a.userPools]),
      allow(['apigateway:POST'], [a.restApis]),
      allow(['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
        [`${a.restApis}/*`]),
      allow([
        'dynamodb:CreateTable', 'dynamodb:DescribeTable', 'dynamodb:UpdateTable', 'dynamodb:DeleteTable',
        'dynamodb:DescribeContinuousBackups', 'dynamodb:UpdateContinuousBackups',
        'dynamodb:DescribeTimeToLive', 'dynamodb:TagResource', 'dynamodb:UntagResource', 'dynamodb:ListTagsOfResource',
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
      // Web bucket configuration only: objects are written by the publisher, never by CloudFormation.
      allow([
        's3:CreateBucket', 's3:DeleteBucket', 's3:ListBucket', 's3:GetBucketLocation',
        's3:PutBucketPublicAccessBlock', 's3:GetBucketPublicAccessBlock', 's3:PutEncryptionConfiguration',
        's3:GetEncryptionConfiguration', 's3:PutBucketOwnershipControls', 's3:GetBucketOwnershipControls',
        's3:PutBucketTagging', 's3:GetBucketTagging', 's3:PutBucketPolicy', 's3:GetBucketPolicy', 's3:DeleteBucketPolicy',
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
    allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [regional('logs', `log-group:/aws/lambda/${named}`)]),
    allow(['dynamodb:*'], [regional('dynamodb', `table/${named}`)]),
    allow(['sqs:*'], [regional('sqs', named)]),
    allow(['lambda:*'], [regional('lambda', `function:${named}`), regional('lambda', 'event-source-mapping:*'),
      regional('lambda', `layer:${named}`), regional('lambda', `layer:${named}:*`)]),
    allow(['cognito-idp:*'], [regional('cognito-idp', 'userpool/*')]),
    allow(['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'],
      [`arn:${t.partition}:apigateway:${t.region}::/restapis`, `arn:${t.partition}:apigateway:${t.region}::/restapis/*`]),
    allow(['s3:GetObject'], [`arn:${t.partition}:s3:::${bucketName(t)}/${ARTIFACT_PREFIX}*`]),
    allow(['s3:*'], [`arn:${t.partition}:s3:::${webBucketName(t)}`, `arn:${t.partition}:s3:::${webBucketName(t)}/*`]),
    allow(['cloudfront:*'], ['distribution/*', `function/${named}`, 'origin-access-control/*', 'cache-policy/*',
      'response-headers-policy/*'].map(resource => `arn:${t.partition}:cloudfront::${t.account}:${resource}`)),
    allow(['dynamodb:ListStreams', 'cognito-idp:CreateUserPool', 'cognito-idp:DescribeUserPoolDomain',
      'lambda:CreateEventSourceMapping'], ['*'], sameRegion(t)),
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
  ])
}
