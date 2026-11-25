// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { createAnthropicAdapter } from '../../src/models/anthropic.js'
import { createOpenAIAdapter } from '../../src/models/openai.js'
import { ModelPolicyDenied, UncertainSend } from '../../src/models/provider.js'
import { PROVIDER_ORIGINS, createFetchWire } from '../../src/models/wire.fetch.js'
import { CredentialUnavailable } from '../../src/secrets/provider-secret.js'
import { sendEvents, startProviderServer } from '../support/provider-server.js'

// Synthetic keys: shaped like keys, valid nowhere. Every test checks where they do and do not appear.
const keys = { openai: 'sk-synthetic-openai-0123456789abcdef', anthropic: 'sk-ant-synthetic-0123456789abcdef' }
const fixture = (name: string): unknown[] =>
  JSON.parse(readFileSync(new URL('../../contracts/fixtures/providers/' + name + '.json', import.meta.url), 'utf8'))
const limits = { outputTokens: 64, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 }
const request = (provider: 'openai' | 'anthropic', signal = new AbortController().signal) => ({
  provider, model: provider === 'openai' ? 'gpt-6-luna' : 'claude-sonnet-5-5', text: 'Entrada sintética', attemptId: 'attempt', limits, signal,
})
async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}
const credentials = () => ({
  get: vi.fn(async (provider: 'openai' | 'anthropic') => keys[provider]),
  invalidate: vi.fn(),
})

const servers: { close(): Promise<void> }[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })
async function provider(handler: Parameters<typeof startProviderServer>[0]) {
  const server = await startProviderServer(handler)
  servers.push(server)
  return server
}
const adapters = (origin: string, extra: Partial<Parameters<typeof createFetchWire>[0]> = {}, timeoutMs = 2_000) => {
  const creds = credentials()
  const wire = createFetchWire({ credentials: creds, origins: { openai: origin, anthropic: origin }, ...extra })
  return { creds, openai: createOpenAIAdapter(wire, timeoutMs), anthropic: createAnthropicAdapter(wire, timeoutMs) }
}

test('production origins are the exact provider hosts', () => {
  expect(PROVIDER_ORIGINS).toEqual({ openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com' })
  expect(Object.isFrozen(PROVIDER_ORIGINS)).toBe(true)
})

test('wire_sends_one_authenticated_post_per_attempt: OpenAI and Anthropic stream through the real transport', async () => {
  const server = await provider(async (seen, { res }) => {
    await sendEvents(res, fixture(seen.url === '/v1/responses' ? 'openai' : 'anthropic'))
  })
  const { openai, anthropic, creds } = adapters(server.origin)
  expect(await collect(openai.stream(request('openai')))).toEqual([
    { type: 'text', text: '¡Hola!' },
    { type: 'tool', id: 'call_fixture', name: 'weather', arguments: { city: 'Mar del Plata' } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 6, reasoningTokens: 4, toolTokens: 0, toolCalls: 0 } },
  ])
  expect(await collect(anthropic.stream(request('anthropic')))).toEqual([
    { type: 'text', text: 'Claude' },
    { type: 'tool', id: 'tool_fixture', name: 'weather', arguments: { city: 'Mendoza' } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 9, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } },
  ])
  expect(server.requests).toHaveLength(2)
  const [first, second] = server.requests
  expect([first.method, first.url, second.method, second.url]).toEqual(['POST', '/v1/responses', 'POST', '/v1/messages'])
  expect(first.headers.authorization).toBe('Bearer ' + keys.openai)
  expect(first.headers['x-api-key']).toBeUndefined()
  expect(second.headers['x-api-key']).toBe(keys.anthropic)
  expect(second.headers.authorization).toBeUndefined()
  expect(second.headers['anthropic-version']).toBe('2023-06-01')
  for (const seen of server.requests) {
    expect(seen.headers['content-type']).toBe('application/json')
    expect(seen.headers.accept).toBe('text/event-stream')
    expect(seen.body).not.toContain('sk-')
  }
  expect(creds.get).toHaveBeenCalledTimes(2)
})

test('request headers can never replace the credential or the destination', async () => {
  const server = await provider((_seen, { res }) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end() })
  const creds = credentials()
  const wire = createFetchWire({ credentials: creds, origins: { openai: server.origin } })
  const response = await wire({
    provider: 'openai', path: '/v1/responses', body: '{}', signal: new AbortController().signal,
    headers: { authorization: 'Bearer attacker', 'X-Api-Key': 'attacker', host: 'attacker.example', cookie: 'a=b', 'proxy-authorization': 'x',
      'content-type': 'application/json' },
  })
  await response.body?.cancel()
  const [seen] = server.requests
  expect(seen.headers.authorization).toBe('Bearer ' + keys.openai)
  expect(seen.headers['x-api-key']).toBeUndefined()
  expect(seen.headers.cookie).toBeUndefined()
  expect(seen.headers['proxy-authorization']).toBeUndefined()
  expect(seen.headers.host).toBe(new URL(server.origin).host)
})

test.each([301, 302, 303, 307, 308])('wire_rejects_redirects: HTTP %i is never followed', async status => {
  const target = await provider((_seen, { res }) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end() })
  const origin = await provider((_seen, { res }) => { res.writeHead(status, { location: target.origin + '/v1/responses' }); res.end() })
  const { openai, creds } = adapters(origin.origin)
  await expect(collect(openai.stream(request('openai')))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(origin.requests).toHaveLength(1)
  expect(target.requests).toHaveLength(0)
  expect(creds.get).toHaveBeenCalledTimes(1)
})

test.each([
  ['429 with Retry-After', (res: import('node:http').ServerResponse) => { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); res.end('{"error":{"type":"rate_limit_error"}}') }],
  ['500', (res: import('node:http').ServerResponse) => { res.writeHead(500); res.end('{}') }],
  ['503', (res: import('node:http').ServerResponse) => { res.writeHead(503); res.end('{}') }],
  ['529 overloaded', (res: import('node:http').ServerResponse) => { res.writeHead(529); res.end('{}') }],
  ['400 invalid request', (res: import('node:http').ServerResponse) => { res.writeHead(400); res.end('{}') }],
  ['connection reset before any byte', (_res: import('node:http').ServerResponse, socket?: import('node:net').Socket) => { socket?.destroy() }],
])('wire_never_retries: %s leaves one request and an unconfirmed charge', async (_name, answer) => {
  const server = await provider((_seen, { res, socket }) => answer(res, socket))
  const { openai, anthropic } = adapters(server.origin)
  await expect(collect(openai.stream(request('openai')))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(server.requests).toHaveLength(1)
  await expect(collect(anthropic.stream(request('anthropic')))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(server.requests).toHaveLength(2)
})

test('an authentication error confirms nothing ran and drops the cached key', async () => {
  const server = await provider((_seen, { res }) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"type":"authentication_error"}}') })
  const { openai, anthropic, creds } = adapters(server.origin)
  for (const adapter of [openai, anthropic]) {
    expect(await collect(adapter.stream(request(adapter === openai ? 'openai' : 'anthropic')))).toEqual([
      { type: 'usage', failed: true, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } },
    ])
  }
  expect(server.requests).toHaveLength(2)
  expect(creds.invalidate).toHaveBeenCalledTimes(2)
})

test('credential_failure_is_not_sent: no request leaves the process and the attempt settles at zero', async () => {
  const server = await provider((_seen, { res }) => { res.writeHead(200); res.end() })
  const fetch = vi.fn<typeof globalThis.fetch>()
  const creds = { get: vi.fn(async () => { throw new CredentialUnavailable() }), invalidate: vi.fn() }
  const wire = createFetchWire({ credentials: creds, origins: { openai: server.origin }, fetch })
  const adapter = createOpenAIAdapter(wire, 2_000)
  expect(await collect(adapter.stream(request('openai')))).toEqual([
    { type: 'usage', failed: true, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } },
  ])
  expect(fetch).not.toHaveBeenCalled()
  expect(server.requests).toHaveLength(0)
})

test('wire_enforces_origin_allowlist_and_timeout: unknown provider, path or origin never reach fetch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const wire = createFetchWire({ credentials: credentials(), fetch })
  const call = (provider: string, path: string) => wire({ provider, path, headers: {}, body: '{}', signal: new AbortController().signal })
  for (const [name, path] of [['openai', '/v1/messages'], ['anthropic', '/v1/responses'], ['openai', '//evil.example/v1/responses'],
    ['openai', '/v1/responses?x=1'], ['openai', '/v1/responses/../x'], ['openai', 'https://evil.example/v1/responses'],
    ['mistral', '/v1/responses'], ['__proto__', '/v1/responses'], ['constructor', '/v1/responses']]) {
    await expect(call(name, path), `${name} ${path}`).rejects.toThrow('Model request not sent')
  }
  await expect(wire({ provider: 'openai', path: '/v1/responses', headers: {}, body: '{}', signal: AbortSignal.abort() })).rejects.toThrow('Model request not sent')
  expect(fetch).not.toHaveBeenCalled()
})

test.each([
  ['plain http on a public host', { openai: 'http://api.openai.com' }],
  ['https on a different host', { openai: 'https://example.com' }],
  ['a path', { openai: 'http://127.0.0.1:9/v1' }],
  ['credentials in the URL', { openai: 'http://user:pw@127.0.0.1:9' }],
  ['a query', { openai: 'http://127.0.0.1:9?x=1' }],
  ['not a URL', { openai: 'api.openai.com' }],
  ['an unknown provider', { mistral: 'http://127.0.0.1:9' }],
])('origin overrides are loopback only: %s is rejected at construction', (_name, origins) => {
  expect(() => createFetchWire({ credentials: credentials(), origins: origins as never })).toThrow(ModelPolicyDenied)
})

test('wire_enforces_origin_allowlist_and_timeout: a server that never answers is cut at the adapter deadline', async () => {
  const server = await provider(() => {})
  const { openai } = adapters(server.origin, {}, 150)
  const started = performance.now()
  await expect(collect(openai.stream(request('openai')))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(performance.now() - started).toBeLessThan(1_500)
  await vi.waitFor(() => expect(server.disconnected).toBe(1))
  expect(server.requests).toHaveLength(1)
})

test('a stream that stalls after the headers is cut at the deadline and keeps the text already delivered', async () => {
  const server = await provider(async (_seen, { res }) => {
    await sendEvents(res, [fixture('openai')[0]], { end: false })
  })
  const { openai } = adapters(server.origin, {}, 200)
  const iterator = openai.stream(request('openai'))[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: { type: 'text', text: '¡Hola!' } })
  await expect(iterator.next()).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  await vi.waitFor(() => expect(server.disconnected).toBe(1))
  expect(server.requests).toHaveLength(1)
})

test('caller cancellation closes the connection and leaves the charge unconfirmed', async () => {
  const server = await provider(async (_seen, { res }) => { await sendEvents(res, [fixture('openai')[0]], { end: false }) })
  const controller = new AbortController()
  const { openai } = adapters(server.origin)
  const iterator = openai.stream(request('openai', controller.signal))[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ type: 'text', text: '¡Hola!' })
  const pending = iterator.next()
  controller.abort(new Error('private cancellation reason'))
  await expect(pending).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  await vi.waitFor(() => expect(server.disconnected).toBe(1))
  expect(server.requests).toHaveLength(1)
})

test.each([
  ['stream cut mid-event', async (res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"response.output_text.delta","delta":"par')
    await new Promise(resolve => setTimeout(resolve, 20))
    res.destroy()
  }],
  ['malformed JSON event', async (res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {not json}\n\n')
  }],
  ['events without terminal usage', async (res: import('node:http').ServerResponse) => {
    await sendEvents(res, fixture('openai').slice(0, 1))
  }],
  ['terminal event without usage numbers', async (res: import('node:http').ServerResponse) => {
    await sendEvents(res, [{ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 'many' } } }])
  }],
  ['200 with a JSON error body', async (res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"sk-should-never-matter"}}')
  }],
  ['in-stream error event', async (res: import('node:http').ServerResponse) => {
    await sendEvents(res, [fixture('openai')[0], { type: 'error', message: 'overloaded' }])
  }],
  ['billing dimension we did not quote (fast tier)', async (res: import('node:http').ServerResponse) => {
    await sendEvents(res, [{ type: 'response.completed', response: { status: 'completed', service_tier: 'priority',
      usage: { input_tokens: 5, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } } } }])
  }],
])('unknown consumption: %s never becomes a confirmed charge', async (_name, answer) => {
  const server = await provider((_seen, { res }) => answer(res))
  const { openai } = adapters(server.origin)
  await expect(collect(openai.stream(request('openai')))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(server.requests).toHaveLength(1)
})

test('the response hook receives only the provider, the status and a sanitized request id', async () => {
  const seen: unknown[] = []
  let id = 'req_011CSHoEeqs5C35K2UUqR7Fy'
  const server = await provider(async (_seen, { res }) => {
    res.setHeader('request-id', id)
    res.setHeader('set-cookie', 'session=' + keys.anthropic)
    await sendEvents(res, fixture('anthropic'))
  })
  const { anthropic } = adapters(server.origin, { onResponse: meta => seen.push(meta) })
  await collect(anthropic.stream(request('anthropic')))
  id = 'x'.repeat(200) // too long: dropped
  await collect(anthropic.stream(request('anthropic')))
  expect(seen).toEqual([
    { provider: 'anthropic', status: 200, requestId: 'req_011CSHoEeqs5C35K2UUqR7Fy' },
    { provider: 'anthropic', status: 200 },
  ])
  expect(JSON.stringify(seen)).not.toContain(keys.anthropic)
})
