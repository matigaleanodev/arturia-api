// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Duration, Token, aws_apigateway as gateway, aws_cognito as cognito, aws_dynamodb as dynamodb,
  aws_iam as iam, aws_lambda as lambda } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { TIMING, type Timing } from '../src/config/timing.ts'
import { CORS, CORS_ORIGIN_VARIABLE, isAllowedOrigin } from '../src/http/cors.ts'
import { HTTP_ROUTES, STREAM_ROUTE, TURN_ROUTE } from '../src/http/routes.ts'
import { ARTURIA_ACCESS_SCOPE } from '../src/identity/actor.ts'
import { addChatStream } from './chat-stream.ts'

/** Item actions of the HTTP handler, including those inside its transactions (TransactGet needs GetItem). */
export const HTTP_TABLE_ACTIONS = ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query',
  'dynamodb:UpdateItem']

/**
 * Stage throttling targets in requests per second. API Gateway applies stage limits to each method
 * separately and on a best-effort basis. The accepted-turn and SSE routes get lower limits: turns feed
 * a worker capped at a few concurrent generations (the queue absorbs bursts), and each SSE request
 * holds a streaming function for up to the integration timeout.
 */
export interface Traffic {
  readonly rateLimit: number
  readonly burstLimit: number
  readonly turnRateLimit: number
  readonly turnBurstLimit: number
  readonly streamRateLimit: number
  readonly streamBurstLimit: number
}

/** Ceiling for concurrent SSE functions admitted by the throttle, kept far below a default account quota. */
export const STREAM_CONCURRENCY_CEILING = 40

/** Upper bound of concurrent SSE functions the throttle admits: steady rate over one stream plus the burst. */
export const streamConcurrencyBound = (t: Traffic, timing: Timing = TIMING) =>
  t.streamRateLimit * timing.sseIntegrationTimeoutSeconds + t.streamBurstLimit

export function checkTraffic(t: Traffic, timing: Timing = TIMING): Traffic {
  const broken: string[] = []
  const rule = (ok: boolean, message: string) => { if (!ok) broken.push(message) }
  for (const [name, value] of Object.entries(t)) rule(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
  rule(t.turnRateLimit <= t.rateLimit && t.streamRateLimit <= t.rateLimit, 'route rate limits cannot exceed the stage rate')
  rule(t.turnBurstLimit <= t.burstLimit && t.streamBurstLimit <= t.burstLimit, 'route burst limits cannot exceed the stage burst')
  rule(streamConcurrencyBound(t, timing) <= STREAM_CONCURRENCY_CEILING, `SSE throttle admits more than ${STREAM_CONCURRENCY_CEILING} streams`)
  if (broken.length) throw new RangeError('Invalid traffic limits: ' + broken.join('; '))
  return t
}

export const TRAFFIC: Traffic = checkTraffic({
  rateLimit: 10, burstLimit: 20, turnRateLimit: 1, turnBurstLimit: 5, streamRateLimit: 1, streamBurstLimit: 4,
})

export interface ChatApiProps {
  readonly table: dynamodb.ITable
  readonly pool: cognito.IUserPool
  readonly clientId: string
  /** One exact HTTPS origin. May be a token: the pilot passes the web distribution's origin. */
  readonly allowedOrigin: string
  readonly httpCode: lambda.Code
  readonly streamCode: lambda.Code
  readonly httpRole?: iam.IRole
  readonly streamRole?: iam.IRole
  readonly httpFunctionName?: string
  readonly streamFunctionName?: string
  /** Fixed name: CloudWatch publishes REST API metrics under the ApiName dimension. */
  readonly restApiName?: string
  readonly traffic?: Traffic
  /** Off by default. When set it must cover every stream the throttle admits. */
  readonly sseReservedConcurrency?: number
}

const PUBLIC_ERRORS = [
  [gateway.ResponseType.UNAUTHORIZED, 'UNAUTHENTICATED', 'Se requiere una sesión válida.'],
  [gateway.ResponseType.ACCESS_DENIED, 'PERMISSION_REVOKED', 'El acceso no está permitido.'],
  [gateway.ResponseType.THROTTLED, 'RATE_LIMITED', 'Hay demasiadas solicitudes.'],
] as const

/**
 * Single Regional REST API for every v0.1 route. Each route requires the Cognito access scope; only the
 * CORS preflights are anonymous. The RestApi resource itself never references the origin, so a later
 * distribution can read the API by id while the API takes its origin from the distribution.
 */
export function addChatApi(scope: Construct, props: ChatApiProps) {
  const { table, pool, clientId, allowedOrigin } = props
  const traffic = checkTraffic(props.traffic ?? TRAFFIC)
  if (!Token.isUnresolved(allowedOrigin) && !isAllowedOrigin(allowedOrigin)) {
    throw new RangeError('Invalid CORS origin: use one exact https origin')
  }
  const bound = streamConcurrencyBound(traffic)
  if (props.sseReservedConcurrency !== undefined && !(props.sseReservedConcurrency >= bound)) {
    throw new RangeError(`SSE reserved concurrency must cover the ${bound} streams the throttle admits`)
  }
  const routeLimit = (rate: number, burst: number) => ({ throttlingRateLimit: rate, throttlingBurstLimit: burst })
  const api = new gateway.RestApi(scope, 'RegionalApi', {
    restApiName: props.restApiName,
    endpointConfiguration: { types: [gateway.EndpointType.REGIONAL] }, cloudWatchRole: false,
    deployOptions: {
      ...routeLimit(traffic.rateLimit, traffic.burstLimit),
      methodOptions: {
        [`${TURN_ROUTE.path}/${TURN_ROUTE.method}`]: routeLimit(traffic.turnRateLimit, traffic.turnBurstLimit),
        [`${STREAM_ROUTE.path}/${STREAM_ROUTE.method}`]: routeLimit(traffic.streamRateLimit, traffic.streamBurstLimit),
      },
    },
  })
  const authorizer = new gateway.CognitoUserPoolsAuthorizer(scope, 'ApiAccess', { cognitoUserPools: [pool] })
  const http = new lambda.Function(scope, 'HttpDelivery', {
    runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler', code: props.httpCode, role: props.httpRole,
    functionName: props.httpFunctionName, timeout: Duration.seconds(TIMING.httpFunctionTimeoutSeconds), memorySize: 256,
    environment: { ARTURIA_TABLE_NAME: table.tableName, ARTURIA_CLIENT_ID: clientId, [CORS_ORIGIN_VARIABLE]: allowedOrigin },
  })
  http.addToRolePolicy(new iam.PolicyStatement({ actions: HTTP_TABLE_ACTIONS, resources: [table.tableArn] }))
  const integration = new gateway.LambdaIntegration(http, { allowTestInvoke: false })

  const routed = new Map<gateway.IResource, string[]>()
  const track = (resource: gateway.IResource, method: string) => routed.set(resource, [...routed.get(resource) ?? [], method])
  for (const route of HTTP_ROUTES) {
    const resource = api.root.resourceForPath(route.path)
    resource.addMethod(route.method, integration, { authorizer, authorizationScopes: [ARTURIA_ACCESS_SCOPE] })
    track(resource, route.method)
  }
  const streamResource = api.root.resourceForPath(STREAM_ROUTE.path)
  const { reader } = addChatStream(scope, {
    resource: streamResource, authorizer, table, clientId, allowedOrigin, code: props.streamCode,
    reservedConcurrency: props.sseReservedConcurrency, role: props.streamRole, functionName: props.streamFunctionName,
  })
  track(streamResource, STREAM_ROUTE.method)

  for (const [resource, methods] of routed) {
    resource.addCorsPreflight({
      allowOrigins: [allowedOrigin], allowMethods: [...methods, 'OPTIONS'], allowHeaders: [...CORS.allowHeaders],
      maxAge: Duration.seconds(CORS.maxAgeSeconds), statusCode: 204,
    })
  }
  // Customized types do not inherit from DEFAULT_4XX, so every type carries the origin explicitly.
  const responseHeaders = { 'Access-Control-Allow-Origin': `'${allowedOrigin}'`, Vary: "'Origin'" }
  for (const [type, code, message] of PUBLIC_ERRORS) {
    api.addGatewayResponse(code, { type, responseHeaders,
      templates: { 'application/json': JSON.stringify({ code, message, requestId: '$context.requestId' }) } })
  }
  api.addGatewayResponse('DEFAULT_4XX', { type: gateway.ResponseType.DEFAULT_4XX, responseHeaders })
  api.addGatewayResponse('DEFAULT_5XX', { type: gateway.ResponseType.DEFAULT_5XX, responseHeaders })
  return { api, http, stream: reader, authorizer }
}
