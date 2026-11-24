// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, aws_iam as iam } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, test, vi } from 'vitest'
import {
  ARTIFACT_PREFIX, BUNDLES, NAMES, ROLE_NAMES, STACKS, SYNTHETIC_ACCOUNT, boundaryArn, boundaryPolicy,
  operatorPolicy, policy, roleArn, rolePolicies, type Statement, type Target,
} from './delivery.ts'
import { FoundationStack } from './foundation-stack.ts'
import { createPilotStack, resolvePilotTarget, type PilotTarget } from './pilot.ts'

const FIXTURE_BUNDLES = 'infra/fixtures/bundles'
const target: Target = { partition: 'aws', account: '111111111111', region: 'us-east-1' }
const tmp: string[] = []
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'arturia-pilot-')); tmp.push(dir); return dir }
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })

const synthetic: PilotTarget = { synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: FIXTURE_BUNDLES }
function synthPilot(pilotTarget: PilotTarget = synthetic) {
  const app = new App({ outdir: tempDir(), analyticsReporting: false })
  const stack = createPilotStack(app, pilotTarget)
  const assembly = app.synth()
  return { stack, assembly, template: Template.fromStack(stack), artifact: assembly.getStackArtifact(stack.artifactId) }
}
function runApp(context: Record<string, unknown>, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['infra/bin/app.ts'], { encoding: 'utf8', timeout: 15_000,
    env: { PATH: process.env.PATH ?? '', CDK_OUTDIR: tempDir(), CDK_CONTEXT_JSON: JSON.stringify(context), ...env } })
}
const statements = (document: unknown) => (document as { Statement: Statement[] }).Statement
const glob = (pattern: string) =>
  new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
const covers = (ceiling: Statement[], action: string, resource: string) => ceiling.some(statement =>
  statement.Action.some(pattern => glob(pattern).test(action)) && statement.Resource.some(pattern => glob(pattern).test(resource)))
const WILDCARD_ACTIONS = new Set(['dynamodb:ListStreams', 'cognito-idp:CreateUserPool', 'cognito-idp:DescribeUserPoolDomain',
  'lambda:CreateEventSourceMapping'])

test('pilot_synth_with_code_assets_succeeds', () => {
  const { template, assembly } = synthPilot()
  expect(assembly.manifest.missing ?? []).toEqual([])
  const functions = template.findResources('AWS::Lambda::Function')
  const names = Object.values(functions).map(fn => fn.Properties.FunctionName).sort()
  expect(names).toEqual([NAMES.relayFunction, NAMES.streamFunction].sort())
  for (const fn of Object.values(functions)) expect(fn.Properties.Code.S3Key).toBeDefined()
  template.resourceCountIs('AWS::Cognito::UserPool', 1)
  template.resourceCountIs('AWS::DynamoDB::Table', 1)
  template.resourceCountIs('AWS::ApiGateway::RestApi', 1)
}, 20_000)

test('assets_target_foundation_bucket_and_prefix', () => {
  const { artifact, template } = synthPilot()
  const manifest = JSON.parse(readFileSync(join(artifact.assembly.directory, `${artifact.id}.assets.json`), 'utf8'))
  expect(Object.keys(manifest.dockerImages ?? {})).toEqual([])
  const files = Object.values(manifest.files) as { source: { path: string; packaging?: string }; destinations: Record<string, { bucketName: string; objectKey: string; assumeRoleArn?: string }> }[]
  const zipped = files.filter(file => file.source.packaging === 'zip')
  // One code asset per composed function; bundles not yet composed (13.3/13.4) add no assets.
  expect(zipped).toHaveLength(Object.keys(template.findResources('AWS::Lambda::Function')).length)
  for (const file of files) {
    for (const destination of Object.values(file.destinations)) {
      expect(destination.bucketName).toBe(`arturia-artifacts-${SYNTHETIC_ACCOUNT}-us-east-1`)
      expect(destination.objectKey.startsWith(ARTIFACT_PREFIX)).toBe(true)
      expect(destination.assumeRoleArn).toBeUndefined()
    }
  }
}, 20_000)

test('foundation_has_no_assets_and_retains_bucket', () => {
  const app = new App({ outdir: tempDir(), analyticsReporting: false })
  const stack = new FoundationStack(app, 'Foundation')
  const artifact = app.synth().getStackArtifact(stack.artifactId)
  expect(artifact.assets).toEqual([])
  expect(artifact.environment.account).toBe('unknown-account')
  expect(stack.stackName).toBe(STACKS.foundation)
  const template = Template.fromStack(stack)
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: {
      BucketName: { 'Fn::Sub': 'arturia-artifacts-${AWS::AccountId}-${AWS::Region}' },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    },
  })
  const [bucketPolicy] = Object.values(template.findResources('AWS::S3::BucketPolicy'))
  expect(bucketPolicy.Properties.PolicyDocument.Statement).toContainEqual(expect.objectContaining({
    Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }))
  const roles = Object.values(template.findResources('AWS::IAM::Role'))
  expect(roles).toHaveLength(ROLE_NAMES.length)
  for (const role of roles) {
    expect(role.Properties.PermissionsBoundary).toEqual({ 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/arturia-pilot-boundary' })
  }
  expect(Object.keys(template.toJSON().Resources).length).toBe(ROLE_NAMES.length + 2)
})

test('pilot_real_synth_requires_account_region_and_web_dir', () => {
  const web = tempDir()
  const pilot = { 'arturia:target': 'pilot' }
  expect(runApp(pilot).stderr).toContain('arturia:account')
  expect(runApp({ ...pilot, 'arturia:account': '12345' }).stderr).toContain('arturia:account')
  expect(runApp({ ...pilot, 'arturia:account': target.account }).stderr).toContain('arturia:region')
  const located = { ...pilot, 'arturia:account': target.account, 'arturia:region': 'us-east-1' }
  expect(runApp(located).stderr).toContain('ARTURIA_WEB_DIR')
  expect(runApp(located, { ARTURIA_WEB_DIR: join(web, 'missing') }).stderr).toContain('ARTURIA_WEB_DIR')
  expect(runApp({ ...pilot, 'arturia:target': 'prod' }).stderr).toContain('arturia:target')
  for (const context of [pilot, located]) expect(runApp(context).status).not.toBe(0)

  const bundles = tempDir()
  const read = (context: Record<string, unknown>) => (key: string) => context[key]
  expect(() => resolvePilotTarget(read(located), { ARTURIA_WEB_DIR: web }, bundles)).toThrow(/npm run bundle/)
  for (const name of Object.keys(BUNDLES)) {
    mkdirSync(join(bundles, name))
    writeFileSync(join(bundles, name, 'index.cjs'), 'exports.handler=async()=>{}')
  }
  expect(resolvePilotTarget(read(located), { ARTURIA_WEB_DIR: web }, bundles)).toEqual({
    synthetic: false, account: target.account, region: 'us-east-1', bundleDir: bundles, webDir: web })
  const { stack, template } = synthPilot(resolvePilotTarget(read(located), { ARTURIA_WEB_DIR: web }, bundles))
  expect(stack.stackName).toBe(STACKS.pilot)
  expect(template.toJSON().Outputs?.SyntheticSynth).toBeUndefined()
}, 60_000)

test('test_synth_is_marked_non_deployable', () => {
  const result = runApp({})
  expect(result.status, result.stderr).toBe(0)
  const outdir = JSON.parse(readFileSync(join(tmp.at(-1)!, 'manifest.json'), 'utf8'))
  const [id] = Object.keys(outdir.artifacts).filter(key => outdir.artifacts[key].type === 'aws:cloudformation:stack')
  expect(outdir.artifacts[id].properties.stackName).toBe(STACKS.synthetic)
  expect(outdir.artifacts[id].environment).toBe(`aws://${SYNTHETIC_ACCOUNT}/us-east-1`)
  const template = JSON.parse(readFileSync(join(tmp.at(-1)!, `${id}.template.json`), 'utf8'))
  expect(template.Outputs.SyntheticSynth.Value).toBe('true')
  expect(resolvePilotTarget(() => undefined, {})).toEqual(synthetic)
}, 20_000)

describe('pilot_creates_no_iam_roles', () => {
  test('the pilot only imports foundation roles', () => {
    const { template } = synthPilot()
    const json = template.toJSON()
    const types = Object.values(json.Resources as Record<string, { Type: string }>).map(resource => resource.Type)
    expect(types.filter(type => type.startsWith('AWS::IAM::') || type.startsWith('Custom::'))).toEqual([])
    // Grants on imported roles must not fall back to resource policies outside the foundation model.
    expect(types.filter(type => type.endsWith('Policy'))).toEqual([])
    const roles = Object.values(template.findResources('AWS::Lambda::Function'))
      .map(fn => JSON.stringify(fn.Properties.Role)).sort()
    expect(roles).toHaveLength(2)
    ;(['relay', 'stream'] as const).forEach((name, index) => {
      expect(roles[index]).toContain(`:${SYNTHETIC_ACCOUNT}:role/arturia-pilot-${name}`)
    })
    expect(json.Parameters?.BootstrapVersion).toBeUndefined()
  }, 20_000)

  test('foundation roles stay inside the boundary with scoped permissions', () => {
    const policies = rolePolicies(target)
    expect(Object.keys(policies).sort()).toEqual([...ROLE_NAMES].sort())
    const ceiling = statements(boundaryPolicy(target))
    for (const statement of Object.values(policies).flat()) {
      for (const action of statement.Action) {
        for (const resource of statement.Resource) expect(covers(ceiling, action, resource), `${action} ${resource}`).toBe(true)
      }
    }
    for (const statement of ceiling) {
      expect(statement.Action.filter(action => action.startsWith('iam:'))).toEqual(statement.Action.some(a => a.startsWith('iam:')) ? ['iam:PassRole'] : [])
      if (statement.Resource.includes('*')) {
        for (const action of statement.Action) expect(WILDCARD_ACTIONS.has(action), action).toBe(true)
        expect(statement.Condition?.StringEquals?.['aws:RequestedRegion']).toBe(target.region)
      }
    }
    const allowedWildcards = WILDCARD_ACTIONS
    for (const [name, list] of Object.entries(policies)) {
      // IAM enforces 10,240 characters per role inline policy and 6,144 for the managed boundary.
      expect(JSON.stringify(policy(list)).length, name).toBeLessThan(10_240)
      for (const statement of list) {
        expect(statement.Effect).toBe('Allow')
        for (const action of statement.Action) {
          expect(action, name).toMatch(/^[a-z0-9-]+:[A-Z][A-Za-z]+$/)
          if (action.startsWith('iam:')) {
            expect(action, name).toBe('iam:PassRole')
            expect(Object.keys(statement.Condition?.StringEquals ?? {}), name).toEqual(['iam:PassedToService'])
          }
        }
        for (const resource of statement.Resource) {
          if (resource === '*') {
            for (const action of statement.Action) expect(allowedWildcards.has(action), `${name} ${action}`).toBe(true)
            expect(statement.Condition?.StringEquals?.['aws:RequestedRegion'], name).toBe(target.region)
          } else {
            expect(resource.startsWith('arn:aws:'), resource).toBe(true)
            // S3 and API Gateway ARNs carry no account and IAM no region; the rest stay in the target account and region.
            if (resource.startsWith('arn:aws:iam:')) expect(resource, name).toMatch(/^arn:aws:iam::111111111111:role\/arturia-pilot-/)
            else if (!/^arn:aws:(s3|apigateway):/.test(resource)) expect(resource, name).toMatch(/^arn:aws:[a-z0-9-]+:us-east-1:111111111111:/)
            if (resource.startsWith('arn:aws:s3:::')) expect(resource.startsWith('arn:aws:s3:::arturia-artifacts-111111111111-us-east-1'), resource).toBe(true)
          }
        }
      }
    }
    expect(JSON.stringify(boundaryPolicy(target)).length).toBeLessThan(4_500)
    expect(boundaryArn(target)).toBe('arn:aws:iam::111111111111:policy/arturia-pilot-boundary')
  })

  test('cloudformation role scopes event source mappings and invoke permissions', () => {
    const cfn = rolePolicies(target).cloudformation
    const relay = `arn:aws:lambda:us-east-1:111111111111:function:${NAMES.relayFunction}`
    // CreateEventSourceMapping has no resource type: only the function condition can scope it.
    expect(cfn).toContainEqual({ Effect: 'Allow', Action: ['lambda:CreateEventSourceMapping'], Resource: ['*'],
      Condition: { StringEquals: { 'lambda:FunctionArn': relay, 'aws:RequestedRegion': 'us-east-1' } } })
    const permissions = cfn.filter(statement => statement.Action.includes('lambda:AddPermission'))
    expect(permissions).toHaveLength(1)
    expect(permissions[0]?.Action.sort()).toEqual(['lambda:AddPermission', 'lambda:RemovePermission'])
    expect(permissions[0]?.Condition).toEqual({ StringEquals: { 'lambda:Principal': 'apigateway.amazonaws.com' } })
  })

  test('cdk grants on the composed constructs are covered by the role policies', () => {
    // Build the same pilot with mutable roles to capture every grant CDK would drop on immutable ones.
    const spy = vi.spyOn(iam.Role, 'fromRoleArn').mockImplementation((scope, id) =>
      new iam.Role(scope, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }))
    try {
      const { template } = synthPilot()
      const policies = rolePolicies(target)
      const generated = Object.values(template.findResources('AWS::IAM::Policy'))
      expect(generated.length).toBeGreaterThan(0)
      for (const resource of generated) {
        const role = JSON.stringify(resource.Properties.Roles)
        const name = (['stream', 'relay'] as const).find(candidate => role.includes(`${candidate}Role`))
        expect(name, role).toBeDefined()
        const allowed = new Set(policies[name!].flatMap(statement => statement.Action))
        for (const statement of resource.Properties.PolicyDocument.Statement) {
          for (const action of [statement.Action].flat()) expect(allowed.has(action), `${name} ${action}`).toBe(true)
        }
      }
    } finally {
      spy.mockRestore()
    }
  }, 20_000)

  test('runtime roles keep the existing data grants', () => {
    const policies = rolePolicies(target)
    const table = `arn:aws:dynamodb:us-east-1:111111111111:table/${NAMES.table}`
    expect(policies.stream).toContainEqual({ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'], Resource: [table] })
    expect(policies.relay).toContainEqual({ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], Resource: [table],
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'OUTBOX#*' }, Null: { 'dynamodb:LeadingKeys': 'false' } } })
    const relayActions = policies.relay.flatMap(statement => statement.Action)
    expect(relayActions).toContain('sqs:SendMessage')
    expect(relayActions).not.toContain('dynamodb:PutItem')
    expect(policies.stream.flatMap(statement => statement.Action).some(action => action.startsWith('sqs:'))).toBe(false)
  })

  test('the operator can only pass the cloudformation role', () => {
    const operator = statements(operatorPolicy(target))
    const pass = operator.filter(statement => statement.Action.includes('iam:PassRole'))
    expect(pass).toEqual([{ Effect: 'Allow', Action: ['iam:PassRole'], Resource: [roleArn(target, 'cloudformation')],
      Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } } }])
    expect(operator.flatMap(statement => statement.Action).filter(action => action.startsWith('iam:'))).toEqual(['iam:PassRole'])
    const create = operator.find(statement => statement.Action.includes('cloudformation:CreateChangeSet'))
    expect(create?.Condition).toEqual({ StringEquals: { 'cloudformation:RoleArn': roleArn(target, 'cloudformation') },
      Null: { 'cloudformation:ImportResourceTypes': 'true' } })
    const remove = operator.find(statement => statement.Action.includes('cloudformation:DeleteStack'))
    expect(remove?.Condition).toEqual({ StringEquals: { 'cloudformation:RoleArn': roleArn(target, 'cloudformation') } })
    for (const statement of operator) expect(statement.Resource).not.toContain('*')
  })
})
