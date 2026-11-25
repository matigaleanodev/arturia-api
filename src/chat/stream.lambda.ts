// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { once } from 'node:events'
import { type Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createDynamoClient } from '../config/clients.js'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { gatewayClaims } from '../http/auth.js'
import { corsHeaders, readAllowedOrigin } from '../http/cors.js'
import { createStreamReader, dynamoStreamSource } from './stream.reader.js'
import { createStreamHttp, streamError, type StreamRequest, type StreamResponse } from './stream.http.js'
import { ChatStore } from './turns.store.js'

interface GatewayEvent extends StreamRequest {
  requestContext: { requestId: string; authorizer?: { claims?: Record<string, string | number> } }
}
type Metadata = Pick<StreamResponse, 'statusCode' | 'headers'>
type RuntimeHandler = (event: GatewayEvent, output: Writable, context: { getRemainingTimeInMillis(): number }) => Promise<void>
declare const awslambda: {
  streamifyResponse(handler: RuntimeHandler): RuntimeHandler
  HttpResponseStream: { from(output: Writable, metadata: Metadata): Writable }
}

const tableName = process.env.ARTURIA_TABLE_NAME!
const clientId = process.env.ARTURIA_CLIENT_ID!
// Without a valid configured origin no origin is named and browsers cannot read the stream.
const allowedOrigin = readAllowedOrigin(process.env)
const cors = allowedOrigin ? corsHeaders(allowedOrigin) : {}
const store = new ChatStore(createDynamoClient(), tableName)
const streamHttp = createStreamHttp(createStreamReader(dynamoStreamSource(store)))

// Only trusted requestContext claims may select the existing Arturia session.
async function identity(raw: Record<string, string | number> | undefined, signal: AbortSignal) {
  const claims = gatewayClaims(raw, clientId)
  if (!claims) return
  const expiresAt = claims.exp * 1_000
  const authTime = claims.auth_time
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return

  const read = async (pk: string, sk: string) => (await store.db.send(new GetCommand({
    TableName: tableName, Key: { pk, sk }, ConsistentRead: true,
  }), { abortSignal: signal })).Item
  const userId = (await read('SUBJECT', claims.sub))?.userId
  if (typeof userId !== 'string' || !userId) return
  const sessionId = claims.origin_jti
  const session = await read(JSON.stringify([userId]), 'SESSION#' + sessionId)
  if (session?.status !== 'active' || session.authTime !== authTime || expiresAt <= Date.now()) return
  return { actor: { userId, sessionId }, expiresAt }
}

export const handler = awslambda.streamifyResponse(async (event, output, context) => {
  const disconnected = new AbortController()
  const onClose = () => disconnected.abort()
  output.once('close', onClose)
  output.once('error', onClose)
  // Leave time to flush before the runtime and API Gateway limits.
  const budget = Math.max(1, Math.min(24_000, context.getRemainingTimeInMillis() - 1_000))
  let deadline = Date.now() + budget
  let signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(budget)])
  const requestId = event.requestContext.requestId
  try {
    let response: StreamResponse
    try {
      const principal = await identity(event.requestContext.authorizer?.claims, signal)
      if (principal) {
        deadline = Math.min(deadline, principal.expiresAt)
        signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, Math.min(budget, principal.expiresAt - Date.now())))])
      }
      response = await streamHttp({ ...event, requestId }, principal?.actor, signal)
    } catch (error) {
      response = streamError(error, requestId)
    }
    const writer = awslambda.HttpResponseStream.from(output, { statusCode: response.statusCode, headers: { ...response.headers, ...cors } })
    let wroteBody = false
    for await (const batch of response.body) {
      if (signal.aborted || Date.now() >= deadline) break
      wroteBody = true
      if (!writer.write(batch)) await once(writer, 'drain', { signal })
    }
    if (!writer.destroyed && !disconnected.signal.aborted) {
      const flushed = finished(writer, { cleanup: true, readable: false,
        signal: AbortSignal.timeout(Math.max(1, Math.min(800, context.getRemainingTimeInMillis() - 100))) })
      // The runtime writes API Gateway metadata only on the first write.
      if (!wroteBody) writer.write('')
      writer.end()
      await flushed
    }
  } catch (error) {
    if (!output.destroyed) output.destroy()
    if (!signal.aborted) throw error
  } finally {
    output.off('close', onClose)
    output.off('error', onClose)
  }
})
