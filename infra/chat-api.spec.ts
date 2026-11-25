// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { readFileSync } from 'node:fs'
import { App, CfnParameter, CfnResource, Lazy, Stack, aws_cognito as cognito, aws_dynamodb as dynamodb, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, test } from 'vitest'
import { HTTP_TABLE_ACTIONS, TRAFFIC, addChatApi, checkTraffic, streamConcurrencyBound, type Traffic } from './chat-api.ts'
import { TIMING } from '../src/config/timing.ts'
import { CORS } from '../src/http/cors.ts'

const ORIGIN = 'https://d111111abcdef8.cloudfront.net'
const HTTP_FN = 'fixture-http'
const STREAM_FN = 'fixture-stream'
type Resource = { Type: string; Properties: Record<string, any>; DependsOn?: string | string[] }

function compose(options: { origin?: string; sseReservedConcurrency?: number; traffic?: Traffic; stack?: Stack } = {}) {
  const stack = options.stack ?? new Stack(new App(), 'Fixture', { env: { account: '111111111111', region: 'us-east-1' } })
  const table = dynamodb.Table.fromTableName(stack, 'ChatTable', 'FixtureTable')
  const pool = cognito.UserPool.fromUserPoolId(stack, 'Pool', 'us-east-1_Fixture')
  const code = lambda.Code.fromInline('exports.handler=async()=>{}')
  const parts = addChatApi(stack, {
    table, pool, clientId: 'fixtureclient', allowedOrigin: options.origin ?? ORIGIN, httpCode: code, streamCode: code,
    httpFunctionName: HTTP_FN, streamFunctionName: STREAM_FN, sseReservedConcurrency: options.sseReservedConcurrency, traffic: options.traffic,
  })
  return { stack, parts, template: Template.fromStack(stack) }
}
const resources = (template: Template) => template.toJSON().Resources as Record<string, Resource>
function methods(template: Template) {
  const all = resources(template)
  const paths: Record<string, string> = {}
  const pathOf = (id: string): string => {
    if (paths[id] !== undefined) return paths[id]!
    const { ParentId, PathPart } = all[id]!.Properties
    return (paths[id] = (ParentId.Ref ? pathOf(ParentId.Ref) : '') + '/' + PathPart)
  }
  return Object.values(all).filter(r => r.Type === 'AWS::ApiGateway::Method').map(m => ({
    path: m.Properties.ResourceId.Ref ? pathOf(m.Properties.ResourceId.Ref) : '/', verb: m.Properties.HttpMethod as string, props: m.Properties,
  }))
}
const functionId = (template: Template, name: string) =>
  Object.entries(resources(template)).find(([, r]) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === name)![0]
const contract = JSON.parse(readFileSync('contracts/openapi.json', 'utf8')) as { paths: Record<string, Record<string, unknown>> }
const contractRoutes = Object.entries(contract.paths)
  .flatMap(([path, item]) => Object.keys(item).filter(key => key !== 'parameters').map(verb => `${verb.toUpperCase()} ${path}`)).sort()
const quoted = (value: string) => `'${value}'`

test('all_contract_routes_mapped_with_cognito_scope', () => {
  const { template } = compose()
  const routed = methods(template).filter(m => m.verb !== 'OPTIONS')
  expect(routed.map(m => `${m.verb} ${m.path}`).sort()).toEqual(contractRoutes)
  const [authorizerId, authorizer] = Object.entries(resources(template)).find(([, r]) => r.Type === 'AWS::ApiGateway::Authorizer')!
  expect(authorizer.Properties).toMatchObject({ Type: 'COGNITO_USER_POOLS', IdentitySource: 'method.request.header.Authorization' })
  const http = functionId(template, HTTP_FN)
  const stream = functionId(template, STREAM_FN)
  for (const { path, verb, props } of routed) {
    expect(props, `${verb} ${path}`).toMatchObject({ AuthorizationType: 'COGNITO_USER_POOLS', AuthorizationScopes: ['arturia/access'],
      AuthorizerId: { Ref: authorizerId }, Integration: { Type: 'AWS_PROXY', IntegrationHttpMethod: 'POST' } })
    const uri = JSON.stringify(props.Integration.Uri)
    if (path.endsWith('/events')) {
      expect(props.Integration.ResponseTransferMode).toBe('STREAM')
      expect(uri).toContain(stream)
      expect(uri).toContain('response-streaming-invocations')
    } else {
      expect(props.Integration.ResponseTransferMode ?? 'BUFFERED').toBe('BUFFERED')
      expect(uri).toContain(http)
      expect(uri).not.toContain('response-streaming')
    }
  }
  // Only CORS preflights are anonymous, and nothing hangs from the root.
  for (const m of methods(template)) {
    if (m.props.AuthorizationType === 'NONE' || !m.props.AuthorizationType) expect(m.verb).toBe('OPTIONS')
    expect(m.path).not.toBe('/')
  }
  template.resourceCountIs('AWS::ApiGateway::RestApi', 1)
  template.hasResourceProperties('AWS::ApiGateway::RestApi', { EndpointConfiguration: { Types: ['REGIONAL'] } })
})

test('preflight_allows_only_configured_origin', () => {
  const { template } = compose()
  const preflights = methods(template).filter(m => m.verb === 'OPTIONS')
  const routed = methods(template).filter(m => m.verb !== 'OPTIONS')
  expect(preflights.map(m => m.path).sort()).toEqual([...new Set(routed.map(m => m.path))].sort())
  for (const { path, props } of preflights) {
    expect(props.AuthorizationType).toBe('NONE')
    expect(props.Integration.Type).toBe('MOCK')
    const [response] = props.Integration.IntegrationResponses
    const headers = response.ResponseParameters as Record<string, string>
    expect(headers['method.response.header.Access-Control-Allow-Origin']).toBe(quoted(ORIGIN))
    expect(headers['method.response.header.Access-Control-Allow-Headers']).toBe(quoted(CORS.allowHeaders.join(',')))
    const verbs = routed.filter(m => m.path === path).map(m => m.verb)
    expect(headers['method.response.header.Access-Control-Allow-Methods']?.replace(/'/g, '').split(',').sort())
      .toEqual([...verbs, 'OPTIONS'].sort())
    expect(headers['method.response.header.Access-Control-Allow-Credentials']).toBeUndefined()
    expect(response.ResponseTemplates?.['application/json'] ?? '').not.toContain('origin')
  }
})

test('all_gateway_responses_carry_cors', () => {
  const { template } = compose()
  const responses = Object.values(resources(template)).filter(r => r.Type === 'AWS::ApiGateway::GatewayResponse').map(r => r.Properties)
  expect(responses.map(r => r.ResponseType).sort()).toEqual(['ACCESS_DENIED', 'DEFAULT_4XX', 'DEFAULT_5XX', 'THROTTLED', 'UNAUTHORIZED'])
  for (const response of responses) {
    expect(response.ResponseParameters, response.ResponseType).toEqual({
      'gatewayresponse.header.Access-Control-Allow-Origin': quoted(ORIGIN), 'gatewayresponse.header.Vary': quoted('Origin') })
  }
  const byType = (type: string) => responses.find(r => r.ResponseType === type)!
  for (const [type, status, code] of [['UNAUTHORIZED', '401', 'UNAUTHENTICATED'], ['ACCESS_DENIED', '403', 'PERMISSION_REVOKED'],
    ['THROTTLED', '429', 'RATE_LIMITED']]) {
    expect(byType(type!).StatusCode ?? status).toBe(status)
    expect(JSON.parse(byType(type!).ResponseTemplates['application/json'])).toEqual({ code, message: expect.any(String), requestId: '$context.requestId' })
  }
  expect(JSON.stringify(template.toJSON())).not.toMatch(/Access-Control-Allow-Origin":"'\*'/)
  // Gateway responses only reach the stage through a deployment created after them.
  const all = resources(template)
  const deployment = Object.values(all).find(r => r.Type === 'AWS::ApiGateway::Deployment')!
  const gatewayIds = Object.keys(all).filter(id => all[id]!.Type === 'AWS::ApiGateway::GatewayResponse')
  expect([deployment.DependsOn].flat()).toEqual(expect.arrayContaining(gatewayIds))
})

test('sse_metadata_carries_cors_and_no_store', () => {
  const { template } = compose()
  const fn = (name: string) => resources(template)[functionId(template, name)]!.Properties
  for (const name of [HTTP_FN, STREAM_FN]) {
    expect(fn(name).Environment.Variables, name).toMatchObject({ ARTURIA_ALLOWED_ORIGIN: ORIGIN, ARTURIA_TABLE_NAME: 'FixtureTable',
      ARTURIA_CLIENT_ID: 'fixtureclient' })
  }
  expect(fn(HTTP_FN)).toMatchObject({ Runtime: 'nodejs24.x', Handler: 'index.handler', Timeout: TIMING.httpFunctionTimeoutSeconds })
  expect(fn(STREAM_FN)).toMatchObject({ Timeout: TIMING.sseFunctionTimeoutSeconds })
})

describe('stage_throttling_configured', () => {
  test('stage and method limits are synthesized', () => {
    const { template } = compose()
    const [stage] = Object.values(resources(template)).filter(r => r.Type === 'AWS::ApiGateway::Stage')
    const settings = stage!.Properties.MethodSettings as Record<string, unknown>[]
    expect(settings).toContainEqual(expect.objectContaining({ ResourcePath: '/*', HttpMethod: '*',
      ThrottlingRateLimit: TRAFFIC.rateLimit, ThrottlingBurstLimit: TRAFFIC.burstLimit }))
    expect(settings).toContainEqual(expect.objectContaining({ ResourcePath: '/~1v1~1scopes~1{scopeId}~1turns~1{turnId}~1events', HttpMethod: 'GET',
      ThrottlingRateLimit: TRAFFIC.streamRateLimit, ThrottlingBurstLimit: TRAFFIC.streamBurstLimit }))
    expect(settings).toContainEqual(expect.objectContaining({
      ResourcePath: '/~1v1~1scopes~1{scopeId}~1conversations~1{conversationId}~1turns', HttpMethod: 'POST',
      ThrottlingRateLimit: TRAFFIC.turnRateLimit, ThrottlingBurstLimit: TRAFFIC.turnBurstLimit }))
    expect(TRAFFIC).toMatchObject({ rateLimit: 10, burstLimit: 20 })
    // No metrics or logging: those need the account CloudWatch role (13.8).
    for (const setting of settings) expect(setting.MetricsEnabled ?? false).toBe(false)
    expect(stage!.Properties.MethodSettings.some((s: Record<string, unknown>) => s.LoggingLevel)).toBe(false)
  })

  test('limits stay within the stage and the streaming capacity', () => {
    expect(() => checkTraffic(TRAFFIC)).not.toThrow()
    // Each stream holds a function for up to the integration timeout.
    expect(streamConcurrencyBound(TRAFFIC, TIMING)).toBe(TRAFFIC.streamRateLimit * TIMING.sseIntegrationTimeoutSeconds + TRAFFIC.streamBurstLimit)
    for (const broken of [
      { ...TRAFFIC, streamRateLimit: TRAFFIC.rateLimit + 1 }, { ...TRAFFIC, turnBurstLimit: TRAFFIC.burstLimit + 1 },
      { ...TRAFFIC, streamRateLimit: 5 }, { ...TRAFFIC, rateLimit: 0 }, { ...TRAFFIC, burstLimit: 1.5 },
      { ...TRAFFIC, turnBurstLimit: 0 },
    ]) expect(() => checkTraffic(broken), JSON.stringify(broken)).toThrow(RangeError)
    expect(() => compose({ traffic: { ...TRAFFIC, streamRateLimit: 50 } })).toThrow(RangeError)
  })
})

test('sse_reserved_concurrency_off_unless_configured', () => {
  const fn = (template: Template) => resources(template)[functionId(template, STREAM_FN)]!.Properties
  expect(fn(compose().template).ReservedConcurrentExecutions).toBeUndefined()
  expect(resources(compose().template)[functionId(compose().template, HTTP_FN)]!.Properties.ReservedConcurrentExecutions).toBeUndefined()
  const bound = streamConcurrencyBound(TRAFFIC, TIMING)
  expect(fn(compose({ sseReservedConcurrency: bound }).template).ReservedConcurrentExecutions).toBe(bound)
  // Below the throttle bound, excess streams would fail as Lambda throttles instead of the public 429.
  expect(() => compose({ sseReservedConcurrency: bound - 1 })).toThrow(RangeError)
  expect(() => compose({ sseReservedConcurrency: 0 })).toThrow(RangeError)
})

test('http_lambda_has_transactional_table_access_only', () => {
  const { template } = compose()
  expect([...HTTP_TABLE_ACTIONS].sort()).toEqual(['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem',
    'dynamodb:Query', 'dynamodb:UpdateItem'])
  const policies = Object.values(resources(template)).filter(r => r.Type === 'AWS::IAM::Policy')
  const http = policies.find(p => JSON.stringify(p.Properties.Roles).includes('HttpDelivery'))
  expect(http!.Properties.PolicyDocument.Statement).toEqual([expect.objectContaining({ Effect: 'Allow', Action: HTTP_TABLE_ACTIONS })])
  const invokes = Object.values(resources(template)).filter(r => r.Type === 'AWS::Lambda::Permission')
  for (const permission of invokes) {
    expect(permission.Properties).toMatchObject({ Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com' })
    // Scoped to this API and its prod stage, never the test-invoke stage.
    expect(JSON.stringify(permission.Properties.SourceArn)).not.toContain('test-invoke-stage')
  }
})

test('origin_from_a_future_distribution_creates_no_dependency_cycle', () => {
  const stack = new Stack(new App(), 'Cycle', { env: { account: '111111111111', region: 'us-east-1' } })
  let distribution: CfnResource | undefined
  // 13.6: the distribution reads the API by restApiId (CSP) and the API takes its origin from the distribution.
  const origin = Lazy.string({ produce: () => `https://${distribution!.getAtt('DomainName')}` })
  const code = lambda.Code.fromInline('exports.handler=async()=>{}')
  const parts = addChatApi(stack, { table: dynamodb.Table.fromTableName(stack, 'ChatTable', 'FixtureTable'),
    pool: cognito.UserPool.fromUserPoolId(stack, 'Pool', 'us-east-1_Fixture'), clientId: 'fixtureclient', allowedOrigin: origin,
    httpCode: code, streamCode: code })
  distribution = new CfnResource(stack, 'FutureDistribution', { type: 'AWS::CloudFront::Distribution',
    properties: { DistributionConfig: { Comment: parts.api.restApiId } } })
  const all = resources(Template.fromStack(stack))
  const refs = (value: unknown, found = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach(item => refs(item, found))
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'Ref' && typeof inner === 'string' && all[inner]) found.add(inner)
        else if (key === 'Fn::GetAtt') found.add((inner as string[])[0]!)
        else refs(inner, found)
      }
    }
    return found
  }
  const edges = Object.fromEntries(Object.entries(all).map(([id, r]) =>
    [id, new Set([...refs(r.Properties), ...[r.DependsOn ?? []].flat()])]))
  const state: Record<string, 'open' | 'done'> = {}
  const visit = (id: string, trail: string[]): void => {
    if (state[id] === 'done') return
    if (state[id] === 'open') throw new Error('cycle: ' + [...trail, id].join(' -> '))
    state[id] = 'open'
    for (const next of edges[id] ?? []) visit(next, [...trail, id])
    state[id] = 'done'
  }
  for (const id of Object.keys(all)) visit(id, [])
  const restApi = Object.keys(all).find(id => all[id]!.Type === 'AWS::ApiGateway::RestApi')!
  expect(edges[restApi]!.has('FutureDistribution')).toBe(false)
})

test('origin_parameter_tokens_are_accepted', () => {
  const stack = new Stack(new App(), 'Parameter', { env: { account: '111111111111', region: 'us-east-1' } })
  const parameter = new CfnParameter(stack, 'AllowedOrigin', { type: 'String' })
  const { template } = compose({ stack, origin: parameter.valueAsString })
  const responses = Object.values(resources(template)).filter(r => r.Type === 'AWS::ApiGateway::GatewayResponse')
  for (const response of responses) {
    expect(JSON.stringify(response.Properties.ResponseParameters)).toContain('{"Ref":"AllowedOrigin"}')
  }
  expect(() => compose({ origin: '*' })).toThrow(/origin/i)
  expect(() => compose({ origin: 'http://app.example.com' })).toThrow(/origin/i)
})
