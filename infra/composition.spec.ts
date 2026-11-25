// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Cross-cutting invariants of the final composition (13.9): dependency graph, resource inventory and
// resource-level coverage of every grant CDK derives on the imported runtime roles.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, aws_iam as iam } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { SYNTHETIC_ACCOUNT, rolePolicies, type Statement, type Target } from './delivery.ts'
import { FoundationStack } from './foundation-stack.ts'
import { WEB_FIXTURE_DIR, createPilotStack, type PilotTarget } from './pilot.ts'

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown>; DependsOn?: string | string[] }>
const tmp: string[] = []
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })
const synthetic: PilotTarget = { synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: 'infra/fixtures/bundles',
  webDistDir: WEB_FIXTURE_DIR }
function synthPilot(target: PilotTarget = synthetic) {
  const dir = mkdtempSync(join(tmpdir(), 'arturia-composition-')); tmp.push(dir)
  const app = new App({ outdir: dir, analyticsReporting: false })
  return Template.fromStack(createPilotStack(app, target)).toJSON() as { Resources: Resources; Parameters?: Record<string, unknown> }
}
function synthFoundation() {
  const dir = mkdtempSync(join(tmpdir(), 'arturia-composition-')); tmp.push(dir)
  return Template.fromStack(new FoundationStack(new App({ outdir: dir, analyticsReporting: false }), 'Foundation')).toJSON() as { Resources: Resources }
}

/** Logical IDs referenced by Ref, Fn::GetAtt and Fn::Sub (`${Id}` and `${Id.Attr}`), parameters and pseudo parameters excluded. */
function references(value: unknown, ids: ReadonlySet<string>, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { for (const item of value) references(item, ids, found); return found }
  if (!value || typeof value !== 'object') return found
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'Ref' && typeof inner === 'string' && ids.has(inner)) found.add(inner)
    else if (key === 'Fn::GetAtt') {
      const id = Array.isArray(inner) ? inner[0] : String(inner).split('.')[0]
      if (ids.has(id)) found.add(id)
    } else if (key === 'Fn::Sub') {
      const text = Array.isArray(inner) ? inner[0] : inner
      for (const match of String(text).matchAll(/\$\{([A-Za-z0-9]+)(\.[A-Za-z0-9.]+)?\}/g)) if (ids.has(match[1]!)) found.add(match[1]!)
      if (Array.isArray(inner)) references(inner[1], ids, found)
    } else references(inner, ids, found)
  }
  return found
}
/** Edges resource -> dependency from properties, conditions and DependsOn; returns one cycle if there is any. */
export function findCycle(resources: Resources): string[] | undefined {
  const ids = new Set(Object.keys(resources))
  const edges = new Map<string, Set<string>>()
  for (const [id, resource] of Object.entries(resources)) {
    const deps = references({ ...resource, DependsOn: undefined, Type: undefined }, ids)
    for (const dep of [resource.DependsOn ?? []].flat()) deps.add(dep)
    edges.set(id, deps)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 'visiting'); stack.push(id)
    for (const dep of edges.get(id) ?? []) { const cycle = visit(dep); if (cycle) return cycle }
    stack.pop(); state.set(id, 'done')
  }
  for (const id of ids) { const cycle = visit(id); if (cycle) return cycle }
}

describe('template_has_no_dependency_cycles', () => {
  test('pilot and foundation templates have a topological order', () => {
    for (const template of [synthPilot(), synthPilot({ ...synthetic, workerPaused: true, apiAccessLogs: true, apiRedeploy: 'r1' }), synthFoundation()]) {
      const resources = template.Resources
      expect(Object.keys(resources).length).toBeGreaterThan(5)
      expect(findCycle(resources)).toBeUndefined()
      // Every dependency points at a resource of the same template.
      for (const resource of Object.values(resources)) {
        for (const dep of [resource.DependsOn ?? []].flat()) expect(resources[dep], dep).toBeDefined()
      }
    }
  }, 30_000)

  test('positive control: the detector finds injected cycles through each reference form', () => {
    const { Resources: resources } = synthPilot()
    const distribution = Object.keys(resources).find(id => resources[id]!.Type === 'AWS::CloudFront::Distribution')!
    const api = Object.keys(resources).find(id => resources[id]!.Type === 'AWS::ApiGateway::RestApi')!
    // The CSP reads the API id (13.6): an API that waited on the distribution would close a loop.
    expect(findCycle({ ...resources, [api]: { ...resources[api]!, DependsOn: [distribution] } })).toBeDefined()
    const viaGetAtt = { ...resources[api]!, Properties: { ...resources[api]!.Properties, Description: { 'Fn::GetAtt': [distribution, 'DomainName'] } } }
    expect(findCycle({ ...resources, [api]: viaGetAtt })).toBeDefined()
    const viaSub = { ...resources[api]!, Properties: { ...resources[api]!.Properties, Description: { 'Fn::Sub': `https://\${${distribution}.DomainName}` } } }
    expect(findCycle({ ...resources, [api]: viaSub })).toBeDefined()
  }, 30_000)
})

/** Exact inventory of the pilot (synthetic default). Anything new must be added here deliberately. */
const PILOT_INVENTORY: Record<string, number> = {
  'AWS::Cognito::UserPool': 1, 'AWS::Cognito::UserPoolResourceServer': 1, 'AWS::Cognito::UserPoolDomain': 1, 'AWS::Cognito::UserPoolClient': 1,
  'AWS::Lambda::Function': 5, 'AWS::Lambda::EventSourceMapping': 2, 'AWS::Lambda::Permission': 7, 'AWS::Lambda::LayerVersion': 1,
  'AWS::DynamoDB::Table': 1, 'AWS::SQS::Queue': 3,
  'AWS::ApiGateway::RestApi': 1, 'AWS::ApiGateway::Deployment': 1, 'AWS::ApiGateway::Stage': 1, 'AWS::ApiGateway::Resource': 10,
  'AWS::ApiGateway::Method': 13, 'AWS::ApiGateway::GatewayResponse': 5, 'AWS::ApiGateway::Authorizer': 1,
  'AWS::S3::Bucket': 1, 'AWS::S3::BucketPolicy': 1,
  'AWS::CloudFront::ResponseHeadersPolicy': 2, 'AWS::CloudFront::CachePolicy': 1, 'AWS::CloudFront::Function': 1,
  'AWS::CloudFront::OriginAccessControl': 1, 'AWS::CloudFront::Distribution': 1, 'Custom::CDKBucketDeployment': 3,
  'AWS::Logs::LogGroup': 5, 'AWS::SNS::Topic': 1, 'AWS::SNS::Subscription': 1, 'AWS::CloudWatch::Alarm': 13,
}
const inventory = (resources: Resources) => {
  const counts: Record<string, number> = {}
  for (const { Type } of Object.values(resources)) counts[Type] = (counts[Type] ?? 0) + 1
  return counts
}

test('pilot_resources_match_the_inventory', () => {
  expect(inventory(synthPilot().Resources)).toEqual(PILOT_INVENTORY)
  // The kill switch changes a property, never the inventory; access logs add only their log group.
  expect(inventory(synthPilot({ ...synthetic, workerPaused: true }).Resources)).toEqual(PILOT_INVENTORY)
  expect(inventory(synthPilot({ ...synthetic, apiAccessLogs: true }).Resources))
    .toEqual({ ...PILOT_INVENTORY, 'AWS::Logs::LogGroup': PILOT_INVENTORY['AWS::Logs::LogGroup']! + 1 })
  expect(inventory(synthFoundation().Resources)).toEqual({ 'AWS::S3::Bucket': 1, 'AWS::S3::BucketPolicy': 1, 'AWS::IAM::Role': 6,
    'AWS::IAM::ManagedPolicy': 2, 'AWS::Budgets::Budget': 1, 'AWS::DynamoDB::Table': 1 })
}, 30_000)

describe('iam_minimum_per_function', () => {
  const target: Target = { partition: 'aws', account: SYNTHETIC_ACCOUNT, region: 'us-east-1' }
  const NAME_PROPERTIES = ['TableName', 'QueueName', 'FunctionName', 'TopicName', 'BucketName']
  const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')

  /** Concrete ARN a CDK grant resource stands for, from the referenced resource's fixed name. */
  function concrete(resource: unknown, resources: Resources): string[] {
    if (resource === '*') return ['*']
    const ids = [...references(resource, new Set(Object.keys(resources)))]
    expect(ids, JSON.stringify(resource)).toHaveLength(1)
    const target = resources[ids[0]!]!
    const name = NAME_PROPERTIES.map(key => target.Properties?.[key]).find(value => typeof value === 'string') as string | undefined
    expect(name, `${target.Type} without a fixed name`).toBeDefined()
    const text = JSON.stringify(resource)
    const arn = {
      'AWS::DynamoDB::Table': `arn:aws:dynamodb:us-east-1:${SYNTHETIC_ACCOUNT}:table/${name}`,
      'AWS::SQS::Queue': `arn:aws:sqs:us-east-1:${SYNTHETIC_ACCOUNT}:${name}`,
      'AWS::Lambda::Function': `arn:aws:lambda:us-east-1:${SYNTHETIC_ACCOUNT}:function:${name}`,
    }[target.Type]
    expect(arn, target.Type).toBeDefined()
    if (text.includes('StreamArn')) return [`${arn}/stream/2026-01-01T00:00:00.000`]
    return text.includes('/index/') ? [`${arn}/index/any`] : [arn!]
  }

  test('every grant CDK derives is covered by its role at action and resource level', () => {
    const spy = vi.spyOn(iam.Role, 'fromRoleArn').mockImplementation((scope, id) =>
      new iam.Role(scope, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }))
    try {
      const { Resources: resources } = synthPilot()
      const policies = rolePolicies(target)
      let checked = 0
      for (const grant of Object.values(resources).filter(resource => resource.Type === 'AWS::IAM::Policy')) {
        const role = (['http', 'relay', 'stream', 'worker', 'publisher'] as const).find(name => JSON.stringify(grant.Properties!.Roles).includes(`${name}Role`))!
        // BucketDeployment grants wildcard families on the staging bucket; the publisher's subset is checked in pilot.spec.ts.
        if (role === 'publisher') continue
        const statements = (grant.Properties!.PolicyDocument as { Statement: { Action: string | string[]; Resource: unknown }[] }).Statement
        for (const statement of statements) {
          for (const action of [statement.Action].flat()) {
            for (const resource of [statement.Resource].flat()) {
              for (const arn of concrete(resource, resources)) {
                const covered = policies[role].some((own: Statement) => own.Action.includes(action) &&
                  own.Resource.some(pattern => pattern === arn || (arn !== '*' && glob(pattern).test(arn))))
                expect(covered, `${role} ${action} ${arn}`).toBe(true)
                checked++
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(10)
    } finally { spy.mockRestore() }
  }, 30_000)

  test('runtime roles only reach their own resources', () => {
    const policies = rolePolicies(target)
    const own: Record<string, RegExp> = {
      stream: /(table\/arturia-pilot-chat|\/aws\/lambda\/arturia-pilot-stream:\*)$/,
      http: /(table\/arturia-pilot-chat|\/aws\/lambda\/arturia-pilot-http:\*)$/,
      worker: /(table\/arturia-pilot-chat|table\/arturia-pilot-ledger|arturia-pilot-turns\.fifo|\/aws\/lambda\/arturia-pilot-worker:\*)$/,
      relay: /(table\/arturia-pilot-chat|table\/arturia-pilot-chat\/stream\/\*|arturia-pilot-turns\.fifo|arturia-pilot-relay-dlq|\/aws\/lambda\/arturia-pilot-relay:\*|^\*)$/,
    }
    for (const [role, pattern] of Object.entries(own)) {
      for (const statement of policies[role as keyof typeof policies]) {
        for (const resource of statement.Resource) expect(resource, `${role} ${statement.Action.join(',')}`).toMatch(pattern)
      }
    }
    // No runtime role can read the turn DLQ, publish to SNS or reach another function.
    const runtime = (['stream', 'http', 'worker', 'relay'] as const).flatMap(role => policies[role])
    expect(runtime.flatMap(s => s.Resource).some(r => r.includes('turns-dlq'))).toBe(false)
    expect(runtime.flatMap(s => s.Action).some(a => a.startsWith('sns:') || a.startsWith('lambda:') || a.startsWith('secretsmanager:'))).toBe(false)
  })
})
