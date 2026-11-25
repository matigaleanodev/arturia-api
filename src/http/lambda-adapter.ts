// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { chatHttp } from '../chat/turns.http.js'
import type { Chat } from '../chat/turns.js'
import { resolveVerifiedActor, type Actor, type IdentityStore } from '../identity/actor.js'
import type { Log } from '../observability/log.js'
import { gatewayClaims } from './auth.js'
import { corsHeaders } from './cors.js'
import { HTTP_ROUTES } from './routes.js'

/** API Gateway REST proxy event, limited to the fields the adapter reads. */
export interface RestEvent {
  readonly httpMethod: string
  readonly resource: string
  readonly pathParameters?: Readonly<Record<string, string | undefined>> | null
  readonly headers?: Readonly<Record<string, string | undefined>> | null
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[] | undefined>> | null
  readonly queryStringParameters?: unknown
  readonly body?: string | null
  readonly isBase64Encoded?: boolean
  readonly requestContext: { readonly requestId: string; readonly authorizer?: { readonly claims?: Record<string, unknown> } | null }
}
export interface RestResult { readonly statusCode: number; readonly headers: Record<string, string>; readonly body: string }

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
// Same ceiling as the local transport: JSON escaping can inflate the 384 KiB text limit.
const maxBodyBytes = 3 * 1024 * 1024
type Path = Readonly<Record<string, string | undefined>>
const routes = new Map(HTTP_ROUTES.map(({ method, path, operation }) => [`${method} ${path}`, (params: Path) => ({
  operation,
  ...(path.includes('{conversationId}') && { conversationId: params.conversationId }),
  ...(path.includes('{turnId}') && { turnId: params.turnId }),
})]))

class InvalidRequest extends Error {}
/** `cors` carries the configured origin headers; without a valid origin no origin is named. */
export const publicError = (statusCode: number, code: string, message: string, requestId: string, cors: Record<string, string> = {}): RestResult =>
  ({ statusCode, headers: { ...headers, ...cors }, body: JSON.stringify({ code, message, requestId }) })
export const internalError = (requestId: string, cors?: Record<string, string>) =>
  publicError(500, 'INTERNAL_ERROR', 'No se pudo completar la solicitud.', requestId, cors)

// Single-valued, case-insensitive header. Repeated values are ambiguous and rejected.
function header(event: RestEvent, name: string) {
  const values = new Set<string>()
  for (const source of [event.multiValueHeaders ?? {}, event.headers ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() !== name) continue
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string') values.add(item)
    }
  }
  if (values.size > 1) throw new InvalidRequest()
  return [...values][0]
}

function body(event: RestEvent): unknown {
  if (event.body === null || event.body === undefined || event.body === '') return undefined
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8')
  if (raw.length > maxBodyBytes) throw new InvalidRequest()
  try { return JSON.parse(raw.toString('utf8')) } catch { throw new InvalidRequest() }
}

/** Maps REST proxy events to `chatHttp`. The actor comes only from verified authorizer claims. */
export function createLambdaAdapter(deps: { chat: Chat; identity: IdentityStore; clientId: string; allowedOrigin: string; log: Log }) {
  const { chat, identity, clientId, log } = deps
  const cors = corsHeaders(deps.allowedOrigin)
  return async (event: RestEvent): Promise<RestResult> => {
    const requestId = event.requestContext.requestId
    // turnId correlates the request with the queue message and the worker attempt.
    const respond = (statusCode: number, body: Record<string, unknown>): RestResult => {
      const code = statusCode >= 400 && typeof body.code === 'string' ? body.code : 'HTTP_OK'
      const turnId = typeof body.turnId === 'string' ? body.turnId : event.pathParameters?.turnId
      log(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', code, { requestId, turnId, status: statusCode })
      return { statusCode, headers: { ...headers, ...cors }, body: JSON.stringify(body) }
    }
    const fault = (statusCode: number, code: string, message: string) => respond(statusCode, { code, message, requestId })
    try {
      const route = routes.get(`${event.httpMethod} ${event.resource}`)
      if (!route) return fault(404, 'NOT_FOUND', 'No se encontró el recurso.')
      const path = event.pathParameters ?? {}
      const claims = gatewayClaims(event.requestContext.authorizer?.claims, clientId)
      const actor: Actor | undefined = claims ? await resolveVerifiedActor(identity, claims) : undefined
      let input: { body: unknown; idempotencyKey?: string }
      try {
        input = { body: body(event), idempotencyKey: header(event, 'idempotency-key') }
      } catch (error) {
        if (!(error instanceof InvalidRequest)) throw error
        // Authentication is decided before any request validation.
        if (!actor) input = { body: undefined }
        else return fault(400, 'INVALID_REQUEST', 'La solicitud es inválida.')
      }
      const request = { ...route(path), scopeId: path.scopeId ?? '', actor, requestId, ...input } as Parameters<typeof chatHttp>[1]
      const result = await chatHttp(chat, request, error => log('error', 'UNEXPECTED_FAILURE', { requestId, error }))
      return respond(result.status, result.body)
    } catch (error) {
      log('error', 'UNEXPECTED_FAILURE', { requestId, error })
      return fault(500, 'INTERNAL_ERROR', 'No se pudo completar la solicitud.')
    }
  }
}
