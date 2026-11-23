// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Duration, aws_apigateway as gateway, aws_cognito as cognito, aws_dynamodb as dynamodb,
  aws_iam as iam, aws_lambda as lambda } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { ARTURIA_ACCESS_SCOPE } from '../src/identity/actor.ts'

interface ChatStreamProps {
  table: dynamodb.ITable
  pool: cognito.IUserPool
  clientId: string
  code: lambda.Code
  concurrency?: number
  /** Predefined execution role. When it is immutable, its grants live outside this stack. */
  role?: iam.IRole
  functionName?: string
}

export function addChatStream(scope: Construct, { table, pool, clientId, code, concurrency = 4, role, functionName }: ChatStreamProps) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid SSE concurrency')
  const api = new gateway.RestApi(scope, 'RegionalApi', {
    endpointConfiguration: { types: [gateway.EndpointType.REGIONAL] }, cloudWatchRole: false,
  })
  const reader = new lambda.Function(scope, 'StreamDelivery', {
    runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code, timeout: Duration.seconds(28),
    memorySize: 256, reservedConcurrentExecutions: concurrency, role, functionName,
    environment: { ARTURIA_TABLE_NAME: table.tableName, ARTURIA_CLIENT_ID: clientId },
  })
  reader.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [table.tableArn],
  }))
  const authorizer = new gateway.CognitoUserPoolsAuthorizer(scope, 'ApiAccess', { cognitoUserPools: [pool] })
  api.root.resourceForPath('/v1/scopes/{scopeId}/turns/{turnId}/events').addMethod('GET',
    new gateway.LambdaIntegration(reader, { responseTransferMode: gateway.ResponseTransferMode.STREAM,
      timeout: Duration.seconds(29), allowTestInvoke: false }),
    { authorizer, authorizationScopes: [ARTURIA_ACCESS_SCOPE] })
  for (const [type, code, message] of [
    [gateway.ResponseType.UNAUTHORIZED, 'UNAUTHENTICATED', 'Se requiere una sesión válida.'],
    [gateway.ResponseType.ACCESS_DENIED, 'PERMISSION_REVOKED', 'El acceso no está permitido.'],
    [gateway.ResponseType.THROTTLED, 'RATE_LIMITED', 'Hay demasiadas conexiones activas.'],
  ] as const) {
    api.addGatewayResponse(code, { type, templates: { 'application/json': JSON.stringify({ code, message, requestId: '$context.requestId' }) } })
  }
  return { api, reader, authorizer }
}
