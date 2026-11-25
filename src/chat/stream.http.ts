// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { randomUUID } from 'node:crypto'
import type { Actor } from '../identity/actor.js'
import type { createStreamReader } from './stream.reader.js'
import { ChatError, notFound } from './turns.types.js'

export const streamRoute = '/v1/scopes/{scopeId}/turns/{turnId}/events'
export interface StreamRequest {
  httpMethod: string
  resource: string
  pathParameters?: { scopeId?: string; turnId?: string } | null
  queryStringParameters?: { after?: string } | null
  multiValueQueryStringParameters?: { after?: string[] } | null
  requestId?: string
}
export interface StreamResponse {
  statusCode: number
  headers: Record<string, string>
  body: AsyncIterable<string>
}
export function streamError(error: unknown, requestId: string = randomUUID()): StreamResponse {
  const fault = error instanceof ChatError ? error : new ChatError(500, 'INTERNAL_ERROR', 'No se pudo completar la solicitud.')
  return { statusCode: fault.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: (async function* () { yield JSON.stringify({ code: fault.code, message: fault.message, requestId }) })() }
}

export function createStreamHttp(reader: ReturnType<typeof createStreamReader>) {
  return async (request: StreamRequest, actor?: Actor, signal?: AbortSignal): Promise<StreamResponse> => {
    try {
      if (request.httpMethod !== 'GET' || request.resource !== streamRoute) throw notFound()
      if (!actor) throw new ChatError(401, 'UNAUTHENTICATED', 'Se requiere una sesión válida.')
      const { scopeId, turnId } = request.pathParameters ?? {}
      const values = request.multiValueQueryStringParameters?.after
      const cursor = values?.[0] ?? request.queryStringParameters?.after ?? '0'
      if (!scopeId || !turnId || (values && values.length !== 1) || !/^\d+$/.test(cursor)) {
        throw new ChatError(400, 'INVALID_REQUEST', 'La solicitud es inválida.')
      }
      const stream = reader.readStream(actor, scopeId, turnId, Number(cursor), signal)
      // Resolve auth, resource and first page before committing HTTP 200.
      const first = await stream.next()
      return { statusCode: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
        body: (async function* () {
          try {
            if (!first.done && !signal?.aborted) yield first.value
            yield* stream
          } finally { await stream.return(undefined) }
        })() }
    } catch (error) {
      return streamError(error, request.requestId)
    }
  }
}
