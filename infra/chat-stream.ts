// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Duration, aws_apigateway as gateway, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { TIMING } from '../src/config/timing.ts'
import { CORS_ORIGIN_VARIABLE } from '../src/http/cors.ts'
import { ARTURIA_ACCESS_SCOPE } from '../src/identity/actor.ts'

export interface ChatStreamProps {
  readonly resource: gateway.IResource
  readonly authorizer: gateway.IAuthorizer
  readonly table: dynamodb.ITable
  readonly clientId: string
  readonly allowedOrigin: string
  readonly code: lambda.Code
  /** Off by default: reserving concurrency needs the account quota (A0). */
  readonly reservedConcurrency?: number
  /** Predefined execution role. When it is immutable, its grants live outside this stack. */
  readonly role?: iam.IRole
  readonly functionName?: string
}

/** Read-only streaming Lambda behind the SSE route, invoked with InvokeWithResponseStream. */
export function addChatStream(scope: Construct, props: ChatStreamProps) {
  const { resource, authorizer, table, clientId, allowedOrigin, code, reservedConcurrency, role, functionName } = props
  if (reservedConcurrency !== undefined && (!Number.isInteger(reservedConcurrency) || reservedConcurrency < 1)) {
    throw new RangeError('Invalid SSE concurrency')
  }
  const reader = new lambda.Function(scope, 'StreamDelivery', {
    runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code, timeout: Duration.seconds(TIMING.sseFunctionTimeoutSeconds),
    memorySize: 256, reservedConcurrentExecutions: reservedConcurrency, role, functionName,
    environment: { ARTURIA_TABLE_NAME: table.tableName, ARTURIA_CLIENT_ID: clientId, [CORS_ORIGIN_VARIABLE]: allowedOrigin },
  })
  reader.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [table.tableArn],
  }))
  const method = resource.addMethod('GET',
    new gateway.LambdaIntegration(reader, { responseTransferMode: gateway.ResponseTransferMode.STREAM,
      timeout: Duration.seconds(TIMING.sseIntegrationTimeoutSeconds), allowTestInvoke: false }),
    { authorizer, authorizationScopes: [ARTURIA_ACCESS_SCOPE] })
  return { reader, method }
}
