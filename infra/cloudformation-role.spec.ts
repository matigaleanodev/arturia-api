// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Post-A0 invariants of the CloudFormation role: coverage of the registry handlers, the split between the
// inline policy and the foundation's hosting managed policy, IAM size limits and negative escalation controls.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, test } from 'vitest'
import {
  HOSTING_POLICY_NAME, NAMES, SYNTHETIC_ACCOUNT, boundaryPolicy, cloudformationPolicies, operatorManagedPolicy, policy, roleArn,
  rolePolicies, type Statement, type Target,
} from './delivery.ts'
import { FoundationStack } from './foundation-stack.ts'
import { WEB_FIXTURE_DIR, createPilotStack, type PilotTarget } from './pilot.ts'

type Resource = { Type: string; Properties: Record<string, unknown> }
const tmp: string[] = []
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })
const app = () => { const dir = mkdtempSync(join(tmpdir(), 'arturia-cfn-role-')); tmp.push(dir); return new App({ outdir: dir, analyticsReporting: false }) }
const synthFoundation = () => Template.fromStack(new FoundationStack(app(), 'Foundation')).toJSON() as { Resources: Record<string, Resource> }
const synthPilot = () => {
  const target: PilotTarget = { synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: 'infra/fixtures/bundles',
    webDistDir: WEB_FIXTURE_DIR }
  return Template.fromStack(createPilotStack(app(), target)).toJSON() as { Resources: Record<string, Resource> }
}

const target: Target = { partition: 'aws', account: '111111111111', region: 'us-east-1' }
const longest: Target = { partition: 'aws-us-gov', account: '111111111111', region: 'ap-southeast-2' }
const glob = (pattern: string) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
const grantsAction = (list: Statement[], action: string) => list.some(s => s.Action.some(a => glob(a).test(action)))
const allows = (list: Statement[], action: string, resource: string) =>
  list.some(s => s.Action.some(a => glob(a).test(action)) && s.Resource.some(r => glob(r).test(resource)))
const statementsOf = (document: unknown) => (document as { Statement: Statement[] }).Statement
const size = (list: Statement[]) => JSON.stringify(policy(list)).length

// A0 (describe-type) handler permissions of every pilot resource type, and the actions deliberately not granted.
const handlers = JSON.parse(readFileSync('infra/fixtures/cloudformation-handlers.json', 'utf8')) as {
  types: Record<string, Record<'create' | 'read' | 'update' | 'delete', string[]>>; excluded: string[] }
const excluded = new Set(handlers.excluded)

// A0 group A plus the Goldfish addition (ec2:DescribeNetworkInterfaces), each with the Arturia resource it applies to.
const r = (service: string, resource: string) => `arn:aws:${service}:us-east-1:111111111111:${resource}`
const webBucket = 'arn:aws:s3:::arturia-pilot-web-111111111111-us-east-1'
const GROUP_A: Record<string, string> = {
  'dynamodb:DescribeContributorInsights': r('dynamodb', `table/${NAMES.table}`),
  'dynamodb:DescribeKinesisStreamingDestination': r('dynamodb', `table/${NAMES.table}`),
  'dynamodb:GetResourcePolicy': r('dynamodb', `table/${NAMES.table}`),
  'cognito-idp:ListUserPoolClientSecrets': r('cognito-idp', 'userpool/us-east-1_abc'),
  'lambda:GetFunctionScalingConfig': r('lambda', `function:${NAMES.workerFunction}`),
  'logs:DescribeIndexPolicies': '*',
  'logs:DescribeResourcePolicies': '*',
  'ec2:DescribeNetworkInterfaces': '*',
  ...Object.fromEntries(['GetBucketAcl', 'GetBucketCORS', 'GetBucketVersioning', 'GetBucketWebsite', 'GetBucketLogging',
    'GetBucketNotification', 'GetBucketObjectLockConfiguration', 'GetBucketAbac', 'GetBucketDefaultStorageClass',
    'GetBucketMetadataTableConfiguration', 'GetAccelerateConfiguration', 'GetAnalyticsConfiguration',
    'GetIntelligentTieringConfiguration', 'GetInventoryConfiguration', 'GetLifecycleConfiguration', 'GetMetricsConfiguration',
    'GetReplicationConfiguration', 'TagResource', 'UntagResource', 'ListTagsForResource'].map(a => [`s3:${a}`, webBucket])),
}
const FOREIGN: Record<string, string> = {
  dynamodb: r('dynamodb', 'table/other'), 'cognito-idp': 'arn:aws:cognito-idp:us-west-2:111111111111:userpool/us-west-2_abc',
  lambda: r('lambda', 'function:other'), s3: 'arn:aws:s3:::other-bucket',
}
const HOSTING_SERVICES = ['s3', 'cloudfront', 'logs', 'cloudwatch', 'sns']
const service = (action: string) => action.split(':')[0]!

describe('cloudformation_role_covers_the_registry_handlers', () => {
  const union = rolePolicies(target).cloudformation

  test('the fixture covers every pilot resource type', () => {
    const types = new Set(Object.values(synthPilot().Resources).map(resource => resource.Type).filter(type => type.startsWith('AWS::')))
    for (const type of types) expect(handlers.types[type], type).toBeDefined()
  }, 30_000)

  test('every create, read, update and delete handler action is granted or explicitly excluded, never both', () => {
    const uncovered = new Set<string>()
    for (const [type, byHandler] of Object.entries(handlers.types)) {
      for (const action of Object.values(byHandler).flat()) {
        const granted = grantsAction(union, action)
        expect(granted && excluded.has(action), `${type} ${action} granted and excluded`).toBe(false)
        if (!granted) uncovered.add(action)
      }
    }
    // No stale exclusions: the list is exactly what the role leaves out.
    expect([...uncovered].sort()).toEqual([...excluded].sort())
  })

  test('A0 group A is granted on Arturia resources only, and capped by the boundary', () => {
    expect(Object.keys(GROUP_A)).toHaveLength(28)
    const boundary = statementsOf(boundaryPolicy(target))
    for (const [action, resource] of Object.entries(GROUP_A)) {
      expect(allows(union, action, resource), action).toBe(true)
      expect(allows(boundary, action, resource), `boundary ${action}`).toBe(true)
      if (resource === '*') {
        for (const list of [union, boundary]) {
          const statement = list.find(s => s.Action.includes(action) && s.Resource.includes('*'))
          expect(statement?.Condition, action).toEqual({ StringEquals: { 'aws:RequestedRegion': target.region } })
        }
      } else {
        expect(allows(union, action, FOREIGN[service(action)]!), `${action} on a foreign resource`).toBe(false)
      }
    }
  })
})

test('cloudformation_role_equals_the_approved_baseline_plus_group_a', () => {
  // Action, resource and condition tuples of the 13.9 role (04e9256) plus A0 group A, derived outside this code
  // (infra/fixtures/cloudformation-role-baseline.json). Any widened resource or dropped action fails here.
  const baseline = JSON.parse(readFileSync('infra/fixtures/cloudformation-role-baseline.json', 'utf8')) as { tuples: string[] }
  const tuples = new Set(rolePolicies(target).cloudformation.flatMap(s =>
    s.Action.flatMap(action => s.Resource.map(resource => `${action} ${resource} ${JSON.stringify(s.Condition ?? {})}`))))
  expect([...tuples].sort()).toEqual(baseline.tuples)
})

describe('cloudformation_role_splits_hosting_into_a_foundation_managed_policy', () => {
  test('inline and hosting partition the role permissions without changing them', () => {
    for (const t of [target, longest]) {
      const { inline, hosting } = cloudformationPolicies(t)
      expect([...inline, ...hosting]).toEqual(rolePolicies(t).cloudformation)
      for (const statement of hosting) {
        for (const action of statement.Action) expect(HOSTING_SERVICES, action).toContain(service(action))
      }
      for (const statement of inline) {
        for (const action of statement.Action) {
          expect(['cloudfront', 'logs', 'cloudwatch', 'sns'], action).not.toContain(service(action))
          // The only S3 access left inline is reading the pilot's artifacts.
          if (service(action) === 's3') expect([action, statement.Resource]).toEqual(['s3:GetObject', [expect.stringContaining('arturia-artifacts-')]])
        }
      }
    }
  })

  test('individual and aggregate IAM size limits hold with the longest ARNs', () => {
    for (const t of [target, longest]) {
      const { inline, hosting } = cloudformationPolicies(t)
      // One inline policy: 10,240 characters is both its own and the role's aggregate inline limit.
      expect(size(inline), `inline ${t.partition}`).toBeLessThan(10_240)
      expect(size(hosting), `hosting ${t.partition}`).toBeLessThan(6_144)
      expect(JSON.stringify(boundaryPolicy(t)).length, `boundary ${t.partition}`).toBeLessThan(6_144)
      expect(JSON.stringify(operatorManagedPolicy(t)).length, `operator ${t.partition}`).toBeLessThan(6_144)
    }
    // Room for the 13.10 findings without another split.
    expect(size(cloudformationPolicies(longest).inline)).toBeLessThan(9_000)
    expect(size(cloudformationPolicies(longest).hosting)).toBeLessThan(5_500)
  })

  test('the foundation attaches the hosting policy to the cloudformation role only', () => {
    const resources = Object.entries(synthFoundation().Resources)
    const managed = resources.filter(([, resource]) => resource.Type === 'AWS::IAM::ManagedPolicy')
    const hosting = managed.filter(([, resource]) => resource.Properties.ManagedPolicyName === HOSTING_POLICY_NAME)
    expect(hosting).toHaveLength(1)
    const [[hostingId, hostingPolicy]] = hosting as [[string, Resource]]
    // Attached from the role, never from the policy, so no other principal can receive it through this template.
    for (const key of ['Roles', 'Users', 'Groups']) expect(hostingPolicy.Properties[key], key).toBeUndefined()
    expect(statementsOf(hostingPolicy.Properties.PolicyDocument)).toHaveLength(cloudformationPolicies(target).hosting.length)
    const roles = resources.filter(([, resource]) => resource.Type === 'AWS::IAM::Role')
    for (const [, role] of roles) {
      const attached = role.Properties.ManagedPolicyArns
      if (role.Properties.RoleName === 'arturia-pilot-cloudformation') {
        expect(attached).toEqual([{ Ref: hostingId }])
        const [inline] = role.Properties.Policies as { PolicyDocument: unknown }[]
        expect(statementsOf(inline!.PolicyDocument)).toHaveLength(cloudformationPolicies(target).inline.length)
      } else {
        expect(attached, String(role.Properties.RoleName)).toBeUndefined()
      }
    }
  })
})

describe('cloudformation_role_negative_escalation_controls', () => {
  const ALLOWED_WILDCARD = new Set(['cognito-idp:CreateUserPool', 'cognito-idp:DescribeUserPoolDomain', 'ec2:DescribeNetworkInterfaces',
    'lambda:CreateEventSourceMapping', 'lambda:GetEventSourceMapping', 'logs:DescribeLogGroups', 'logs:DescribeIndexPolicies',
    'logs:DescribeResourcePolicies'])
  const FORBIDDEN = ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion',
    'iam:UpdateAssumeRolePolicy', 'iam:CreateServiceLinkedRole', 'iam:DeleteRolePermissionsBoundary', 'sts:AssumeRole', 'kms:Decrypt',
    'kms:CreateGrant', 'lambda:PublishVersion', 'ec2:DescribeSubnets', 'ec2:CreateNetworkInterface', 's3:PutObject', 's3:DeleteObject',
    'organizations:ListAccounts', 'sso:CreatePermissionSet', 'secretsmanager:GetSecretValue', 'ssm:GetParameter']

  test('both documents only allow, with enumerated actions and no forbidden capability', () => {
    for (const t of [target, longest]) {
      const { inline, hosting } = cloudformationPolicies(t)
      for (const statement of [...inline, ...hosting]) {
        expect(Object.keys(statement).sort()).toEqual(statement.Condition ? ['Action', 'Condition', 'Effect', 'Resource'] : ['Action', 'Effect', 'Resource'])
        expect(statement.Effect).toBe('Allow')
        for (const action of statement.Action) expect(action).toMatch(/^[a-z0-9-]+:[A-Z][A-Za-z]+$/)
      }
      for (const action of FORBIDDEN) expect(grantsAction([...inline, ...hosting], action), action).toBe(false)
      for (const action of excluded) expect(grantsAction([...inline, ...hosting], action), action).toBe(false)
      expect(hosting.some(s => s.Action.some(a => a.startsWith('iam:')))).toBe(false)
    }
  })

  test('the role passes only runtime roles to Lambda, never itself', () => {
    const passes = rolePolicies(target).cloudformation.filter(s => s.Action.includes('iam:PassRole'))
    expect(passes).toHaveLength(1)
    expect(passes[0]!.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } })
    expect(passes[0]!.Resource).not.toContain(roleArn(target, 'cloudformation'))
  })

  test('resource wildcards are limited to resource-less reads or the conditioned mapping, all region bound', () => {
    for (const statement of rolePolicies(target).cloudformation.filter(s => s.Resource.includes('*'))) {
      expect(statement.Resource).toEqual(['*'])
      for (const action of statement.Action) expect(ALLOWED_WILDCARD.has(action), action).toBe(true)
      expect(statement.Condition?.StringEquals?.['aws:RequestedRegion']).toBe(target.region)
    }
  })

  test('tag conditions are deferred for Cognito and API Gateway: no partial hardening that could break rollback', () => {
    const tagged = rolePolicies(target).cloudformation.filter(s => JSON.stringify(s.Condition ?? {}).includes('aws:ResourceTag'))
    expect(tagged).toEqual([])
  })
})

// Found by the pilot teardown (2026-11-25): the delete handlers read an event source mapping with a request that
// IAM authorizes on `*`, and unsubscribe from the topic, not from a subscription ARN. The stack stayed in DELETE_FAILED.
test('cloudformation_role_can_tear_down_event_source_mappings_and_alert_subscriptions', () => {
  const topic = `arn:aws:sns:us-east-1:111111111111:${NAMES.alertsTopic}`
  for (const [where, list] of [['role', rolePolicies(target).cloudformation], ['boundary', statementsOf(boundaryPolicy(target))]] as const) {
    expect(allows(list, 'lambda:GetEventSourceMapping', '*'), `${where}: GetEventSourceMapping on *`).toBe(true)
    expect(allows(list, 'sns:Unsubscribe', topic), `${where}: Unsubscribe on the topic`).toBe(true)
    expect(allows(list, 'sns:Unsubscribe', 'arn:aws:sns:us-east-1:111111111111:other-topic'), `${where}: other topics`).toBe(false)
  }
  const wildcard = rolePolicies(target).cloudformation.find(s => s.Action.includes('lambda:GetEventSourceMapping') && s.Resource.includes('*'))
  expect(wildcard?.Condition?.StringEquals?.['aws:RequestedRegion']).toBe('us-east-1')
})

test('event_source_mappings_reference_function_arns', () => {
  const resources = synthPilot().Resources
  const mappings = Object.values(resources).filter(resource => resource.Type === 'AWS::Lambda::EventSourceMapping')
  expect(mappings).toHaveLength(2)
  const names = new Map(Object.entries(resources).filter(([, resource]) => resource.Type === 'AWS::Lambda::Function')
    .map(([id, resource]) => [id, resource.Properties.FunctionName]))
  const targets = mappings.map(mapping => {
    const ref = mapping.Properties.FunctionName as { 'Fn::GetAtt'?: [string, string] }
    // lambda:FunctionArn in the cloudformation role compares ARNs: the template must not send the function name.
    expect(ref['Fn::GetAtt']?.[1]).toBe('Arn')
    return names.get(ref['Fn::GetAtt']![0])
  })
  expect(targets.sort()).toEqual([NAMES.relayFunction, NAMES.workerFunction].sort())
}, 30_000)
