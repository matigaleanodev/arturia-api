// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App, Stack, aws_apigateway as gateway, aws_cognito as cognito, aws_dynamodb as dynamodb, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { expect, test } from 'vitest'
import { addChatStream } from './chat-stream.js'

function compose(reservedConcurrency?: number) {
  const stack = new Stack(new App(), 'Fixture')
  const table = dynamodb.Table.fromTableName(stack, 'ChatTable', 'FixtureTable')
  const pool = cognito.UserPool.fromUserPoolId(stack, 'Pool', 'us-east-1_Fixture')
  const api = new gateway.RestApi(stack, 'Api', { cloudWatchRole: false })
  const authorizer = new gateway.CognitoUserPoolsAuthorizer(stack, 'Access', { cognitoUserPools: [pool] })
  addChatStream(stack, { resource: api.root.resourceForPath('/v1/scopes/{scopeId}/turns/{turnId}/events'), authorizer, table,
    clientId: 'fixture-client', allowedOrigin: 'https://app.example.com', code: lambda.Code.fromInline('exports.handler=() => {}'),
    reservedConcurrency })
  return Template.fromStack(stack)
}

test('regional_get_streams_from_a_separately_limited_read_only_lambda', () => {
  const template = compose(3)
  const [method] = Object.values(template.findResources('AWS::ApiGateway::Method'))
  expect(method.Properties).toMatchObject({ HttpMethod: 'GET', AuthorizationType: 'COGNITO_USER_POOLS',
    AuthorizationScopes: ['arturia/access'], Integration: { Type: 'AWS_PROXY', IntegrationHttpMethod: 'POST', ResponseTransferMode: 'STREAM' } })
  expect(JSON.stringify(method.Properties.Integration.Uri)).toMatch(/2021-11-15\/functions\/.*response-streaming-invocations/)
  template.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x', Handler: 'index.handler',
    ReservedConcurrentExecutions: 3, Timeout: 28, Environment: { Variables: { ARTURIA_TABLE_NAME: 'FixtureTable',
      ARTURIA_ALLOWED_ORIGIN: 'https://app.example.com' } } })
  const [policy] = Object.values(template.findResources('AWS::IAM::Policy'))
  const grants = policy.Properties.PolicyDocument.Statement
  expect(grants).toHaveLength(1)
  expect(grants[0]).toMatchObject({ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'] })
  expect(JSON.stringify(grants[0].Resource)).toContain('FixtureTable')
  // Invoke permissions only for the deployed stage, never for console test invocations.
  for (const permission of Object.values(template.findResources('AWS::Lambda::Permission'))) {
    expect(JSON.stringify(permission.Properties.SourceArn)).not.toContain('test-invoke-stage')
  }
  expect(Object.values(template.findResources('AWS::Lambda::Function'))[0].Properties.ReservedConcurrentExecutions).toBe(3)
  expect(Object.values(compose().findResources('AWS::Lambda::Function'))[0].Properties.ReservedConcurrentExecutions).toBeUndefined()
  expect(() => compose(0)).toThrow(RangeError)
})
