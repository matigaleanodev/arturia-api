// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App, Stack, aws_cognito as cognito, aws_dynamodb as dynamodb, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { expect, test } from 'vitest'
import { addChatStream } from './chat-stream.js'

test('regional_get_streams_from_a_separately_limited_read_only_lambda', () => {
  const stack = new Stack(new App(), 'Fixture')
  const table = dynamodb.Table.fromTableName(stack, 'ChatTable', 'FixtureTable')
  const pool = cognito.UserPool.fromUserPoolId(stack, 'Pool', 'us-east-1_Fixture')
  addChatStream(stack, { table, pool, clientId: 'fixture-client', code: lambda.Code.fromInline('exports.handler=() => {}'), concurrency: 3 })
  const template = Template.fromStack(stack)
  template.hasResourceProperties('AWS::ApiGateway::RestApi', { EndpointConfiguration: { Types: ['REGIONAL'] } })
  const [method] = Object.values(template.findResources('AWS::ApiGateway::Method'))
  expect(method.Properties).toMatchObject({ HttpMethod: 'GET', AuthorizationType: 'COGNITO_USER_POOLS',
    AuthorizationScopes: ['arturia/access'], Integration: { Type: 'AWS_PROXY', IntegrationHttpMethod: 'POST', ResponseTransferMode: 'STREAM' } })
  expect(JSON.stringify(method.Properties.Integration.Uri)).toMatch(/2021-11-15\/functions\/.*response-streaming-invocations/)
  template.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x', Handler: 'index.handler',
    ReservedConcurrentExecutions: 3, Timeout: 28, Environment: { Variables: { ARTURIA_TABLE_NAME: 'FixtureTable' } } })
  const [policy] = Object.values(template.findResources('AWS::IAM::Policy'))
  const grants = policy.Properties.PolicyDocument.Statement
  expect(grants).toHaveLength(1)
  expect(grants[0]).toMatchObject({ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'] })
  expect(JSON.stringify(grants[0].Resource)).toContain('FixtureTable')
  const segments = Object.values(template.findResources('AWS::ApiGateway::Resource')).map(r => r.Properties.PathPart)
  expect(segments.sort()).toEqual(['v1','scopes','{scopeId}','turns','{turnId}','events'].sort())
})
