import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createGenerationWorker } from '../../src/chat/generate.worker.js'
import { chatHttp } from '../../src/chat/turns.http.js'
import { ChatStore } from '../../src/chat/turns.store.js'
import { createChat } from '../../src/chat/turns.js'
import { resolveHttpActor } from '../../src/http/auth.js'
import { publishOutbox } from '../../src/jobs/outbox.js'
import { SimulatedProvider } from '../../src/models/simulated.js'
import type { ProviderRequest } from '../../src/models/provider.js'
import { provisionIdentities, resolveLocalActor, localScopes } from './chat-web.js'
import { localDynamoClient } from './local-database.ts'
import { TestQueue } from './test-queue.js'

function route(method: string | undefined, path: string) {
  const [, version, scopes, scopeId, resource, id, child, ...rest] = path.split('/').map(decodeURIComponent)
  if (version !== 'v1' || scopes !== 'scopes' || !scopeId || rest.length) return
  if (resource === 'conversations') {
    if (!id && !child && method === 'GET') return { scopeId, operation: 'listConversations' } as const
    if (!id && !child && method === 'POST') return { scopeId, operation: 'createConversation' } as const
    if (id && !child && method === 'GET') return { scopeId, operation: 'getConversation', conversationId: id } as const
    if (id && child === 'turns' && method === 'POST') return { scopeId, operation: 'acceptTurn', conversationId: id } as const
  }
  if (resource === 'turns' && id) {
    if (!child && method === 'GET') return { scopeId, operation: 'getTurn', turnId: id } as const
    if (child === 'cancel' && method === 'POST') return { scopeId, operation: 'cancelTurn', turnId: id } as const
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage) {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 3 * 1024 * 1024) throw new Error('Body exceeds the local transport limit')
    parts.push(chunk)
  }
  if (size) return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown
}

export async function startServer(endpoint: string, table: string, web: string, port: number, control: string) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(web) || !/^arturia-test-[a-f0-9-]{36}$/.test(table)) {
    throw new Error('Expected an isolated local test project')
  }
  const client = localDynamoClient(endpoint)
  const store = new ChatStore(client, table)
  await provisionIdentities(store)
  const chat = createChat(store)
  const queue = new TestQueue()
  const simulated = new SimulatedProvider()

  // Poll committed outbox records independently of the lifetime of browser requests.
  async function consume() {
    for (;;) {
      for (const { userId, scopeId } of localScopes) {
        for (const ref of await store.pendingOutbox(userId, scopeId)) await publishOutbox(store, queue, ref)
      }
      const next = queue.take()
      if (next) {
        const ref = next
        const worker = createGenerationWorker(store, {
          async *stream(request: ProviderRequest) {
            await appendFile(join(control, ref.turnId + '.attempts'), request.attemptId + '\n')
            while (!existsSync(join(control, ref.turnId + '.release'))) {
              await delay(20, undefined, { signal: request.signal })
            }
            yield* simulated.stream(request)
          },
        })
        if (await worker.runTurn(ref, randomUUID()) === 'retry') queue.send(ref)
      }
      await delay(100)
    }
  }

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    if (origin && origin !== web) return json(response, 403, { code: 'ORIGIN_DENIED' })
    if (origin === web) {
      response.setHeader('Access-Control-Allow-Origin', web)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
    }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return }
    if (request.method === 'GET' && request.url === '/healthz') return json(response, 200, { table })
    try {
      const target = route(request.method, new URL(request.url!, 'http://127.0.0.1').pathname)
      if (!target) return json(response, 404, { code: 'NOT_FOUND' })
      const actor = await resolveHttpActor(resolveLocalActor, request.headers.authorization)
      const header = request.headers['idempotency-key']
      const input = {
        ...target, actor, idempotencyKey: typeof header === 'string' ? header : undefined,
        body: await readBody(request),
      }
      const result = await chatHttp(chat, input)
      json(response, result.status, result.body)
    } catch {
      json(response, 400, { code: 'INVALID_REQUEST', message: 'La solicitud es inválida.', requestId: randomUUID() })
    }
  })
  server.listen(port, '127.0.0.1')
  await consume()
}
