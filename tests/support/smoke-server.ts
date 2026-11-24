// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Local rehearsal target for the AWS smoke suite: the public contract over HTTP on loopback, the deployable
// pilot fixture provider (three blocks one second apart), the SSE reader with its production limits and a
// worker fed by the outbox, independent of the browser connection. Synthetic bearer tokens only.

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { createStreamHttp, streamRoute } from '../../src/chat/stream.http.js'
import { createStreamReader, dynamoStreamSource } from '../../src/chat/stream.reader.js'
import { chatHttp } from '../../src/chat/turns.http.js'
import { createChat } from '../../src/chat/turns.js'
import type { ChatStore } from '../../src/chat/turns.store.js'
import type { Actor } from '../../src/identity/actor.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { pilotFixture } from '../../src/models/fixture-provider.js'
import type { Provider } from '../../src/models/provider.js'
import { TestQueue } from './test-queue.js'

interface Grant { readonly actor: Actor; readonly scopeIds: readonly string[] }

function route(method: string | undefined, path: string) {
  const [, version, scopes, scopeId, resource, id, child, ...rest] = path.split('/').map(decodeURIComponent)
  if (version !== 'v1' || scopes !== 'scopes' || !scopeId || rest.length) return
  if (resource === 'conversations') {
    if (!id && !child && method === 'POST') return { scopeId, operation: 'createConversation' } as const
    if (id && child === 'turns' && method === 'POST') return { scopeId, operation: 'acceptTurn', conversationId: id } as const
  }
  if (resource === 'turns' && id && !child && method === 'GET') return { scopeId, operation: 'getTurn', turnId: id } as const
  if (resource === 'turns' && id && child === 'events' && method === 'GET') return { scopeId, operation: 'events', turnId: id } as const
}

async function readBody(request: IncomingMessage) {
  const parts: Buffer[] = []
  for await (const chunk of request) parts.push(chunk as Buffer)
  return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown : undefined
}

export async function startSmokeServer(store: ChatStore, tokens: Readonly<Record<string, Grant>>, provider?: Provider) {
  const chat = createChat(store)
  const streamHttp = createStreamHttp(createStreamReader(dynamoStreamSource(store)))
  const fixture = pilotFixture({ environment: 'pilot', providerMode: 'fixture' })
  if (fixture.kind !== 'stream') throw new Error('The rehearsal uses the streaming fixture')
  const worker = createGenerationWorker(store, provider ?? fixture.provider)
  const queue = new TestQueue()
  const controller = new AbortController()

  // Relay and worker loop: the turn runs whether or not a client is connected.
  const loop = (async () => {
    while (!controller.signal.aborted) {
      for (const { actor, scopeIds } of Object.values(tokens)) {
        for (const scopeId of scopeIds) for (const ref of await store.pendingOutbox(actor.userId, scopeId)) await publishOutbox(store, queue, ref)
      }
      const ref = queue.take()
      if (ref && await worker.runTurn(ref, randomUUID()) === 'retry') queue.send(ref)
      await delay(50).catch(() => {})
    }
  })()

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const target = route(request.method, url.pathname)
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    const actor = token ? tokens[token]?.actor : undefined
    if (!target) { response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"code":"NOT_FOUND"}'); return }
    if (target.operation === 'events') {
      const disconnect = new AbortController()
      response.on('close', () => disconnect.abort())
      const result = await streamHttp({ httpMethod: 'GET', resource: streamRoute, pathParameters: { scopeId: target.scopeId, turnId: target.turnId },
        queryStringParameters: { after: url.searchParams.get('after') ?? '0' } }, actor, disconnect.signal)
      response.writeHead(result.statusCode, result.headers)
      try { for await (const chunk of result.body) { if (disconnect.signal.aborted) break; response.write(chunk) } } catch { /* client gone */ }
      response.end()
      return
    }
    try {
      const idempotencyKey = request.headers['idempotency-key']
      const result = await chatHttp(chat, { ...target, actor, body: await readBody(request),
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined } as Parameters<typeof chatHttp>[1])
      response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result.body))
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end('{"code":"INVALID_REQUEST"}')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/`,
    async close() {
      controller.abort()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await loop
    },
  }
}
