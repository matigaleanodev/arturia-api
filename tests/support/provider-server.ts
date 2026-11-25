// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export interface Recorded { readonly method: string; readonly url: string; readonly headers: IncomingHttpHeaders; readonly body: string }
export interface Reply { readonly res: ServerResponse; readonly socket: Socket }
type Handler = (request: Recorded, reply: Reply) => void | Promise<void>

/** Local stand-in for a provider endpoint: loopback only, records every request, never touches the network. */
export async function startProviderServer(handler: Handler) {
  const requests: Recorded[] = []
  const sockets = new Set<Socket>()
  let disconnected = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.on('close', () => { if (!res.writableFinished) disconnected++ })
      const recorded: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      requests.push(recorded)
      void Promise.resolve(handler(recorded, { res, socket: req.socket })).catch(() => res.destroy())
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    /** Responses the client abandoned before the server finished them. */
    get disconnected() { return disconnected },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export const eventStream = (events: readonly unknown[]) => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')

/** Writes an SSE reply in small pieces so event boundaries fall inside chunks. */
export async function sendEvents(res: ServerResponse, events: readonly unknown[], { end = true, status = 200 } = {}) {
  res.writeHead(status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
  const bytes = Buffer.from(eventStream(events))
  for (let offset = 0; offset < bytes.length; offset += 7) {
    res.write(bytes.subarray(offset, offset + 7))
    await new Promise(resolve => setImmediate(resolve))
  }
  if (end) res.end()
}
