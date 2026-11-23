// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test, vi } from 'vitest'
import { text } from 'node:stream/consumers'
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { createStreamReader, dynamoStreamSource, type StreamSource } from './stream.reader.js'
import { createStreamHttp, streamRoute } from './stream.http.js'
import { forbidden, type TurnStatus } from './turns.types.js'
import { ChatStore } from './turns.store.js'

const actor = { userId: 'fixture-user', sessionId: 'fixture-session' }
const scope = 'fixture-scope', turnId = 'fixture-turn'
const event = (seq: number) => ({ type: 'text' as const, turnId, seq, text: 'ñ\n' + seq })
const frame = <T extends { type: string }>(data: T) => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n'
const terminal = (status: string, lastSeq: number) => frame({ type: 'status', turnId, status, lastSeq })
function setup(status: TurnStatus = 'completed', lastSeq = 5) {
  const snapshot = vi.fn(async () => ({ status, lastSeq }))
  const blocks = vi.fn<StreamSource['blocks']>(async (_ref, after, end, limit) =>
    Array.from({ length: Math.min(end - after, limit) }, (_, i) => event(after + i + 1)))
  const source = { snapshot, blocks }
  const reader = createStreamReader(source, { batchSize: 2, maxConnections: 1, durationMs: 120, idleMs: 10, maxIdleMs: 40, heartbeatMs: 30 })
  return { reader, snapshot, blocks }
}
const collect = (frames: AsyncIterable<string>) => text(frames)

test('stream_catches_up_to_terminal_last_seq', async () => {
  const { reader, blocks } = setup()
  expect(await collect(reader.readStream(actor, scope, turnId, 2))).toBe(
    [event(3), event(4), event(5)].map(frame).join('') + terminal('completed', 5))
  expect(blocks.mock.calls.map(([, cursor, last, limit]) => [cursor, last, limit])).toEqual([[2, 5, 2], [4, 5, 2]])
})

test('revoke_between_batches_suppresses_next', async () => {
  const { reader, snapshot } = setup()
  const stream = reader.readStream(actor, scope, turnId, 2)
  expect((await stream.next()).value).toBe(frame(event(3)) + frame(event(4)))
  snapshot.mockRejectedValue(forbidden())
  expect(await stream.next()).toMatchObject({ done: true })
})

test('blocked_during_page_read_suppresses_buffered_text', async () => {
  const { reader, blocks, snapshot } = setup()
  blocks.mockImplementationOnce(async () => {
    snapshot.mockResolvedValue({ status: 'blocked', lastSeq: 0 })
    return [event(3), event(4)]
  })
  expect(await collect(reader.readStream(actor, scope, turnId, 2))).toBe(terminal('blocked', 0))
})

test('revoked_after_last_text_suppresses_terminal', async () => {
  const { reader, snapshot } = setup('incomplete', 3)
  const stream = reader.readStream(actor, scope, turnId, 2)
  expect((await stream.next()).value).toBe(frame(event(3)))
  snapshot.mockRejectedValue(forbidden())
  expect(await stream.next()).toMatchObject({ done: true })
})

test('a_gap_never_advances_the_cursor_or_sends_a_terminal', async () => {
  const { reader, blocks } = setup()
  blocks.mockResolvedValue([event(3), event(5)])
  await expect(collect(reader.readStream(actor, scope, turnId, 2))).rejects.toThrow()
})

test('timebox_ends_idle_stream', async () => {
  const { reader, blocks, snapshot } = setup('running', 0)
  const stream = collect(reader.readStream(actor, scope, turnId, 0))
  const body = await stream
  expect(body).toContain(frame({ type: 'status', turnId, status: 'running' }))
  expect(body).toContain(': keep-alive\n\n')
  expect(body).not.toContain('lastSeq')
  expect(blocks).not.toHaveBeenCalled()
  expect(snapshot.mock.calls.length).toBeLessThan(10)
})

test('abort_during_read_suppresses_late_data_and_releases_connection', async () => {
  const { reader, blocks } = setup()
  const controller = new AbortController()
  const pending = Promise.withResolvers<ReturnType<typeof event>[]>()
  const started = Promise.withResolvers<void>()
  blocks.mockImplementationOnce(async () => { started.resolve(); return pending.promise })
  const first = collect(reader.readStream(actor, scope, turnId, 2, controller.signal))
  await started.promise
  await expect(collect(reader.readStream(actor, scope, turnId, 2))).rejects.toMatchObject({ status: 429 })
  controller.abort()
  pending.resolve([event(3)])
  expect(await first).toBe('')
  expect(await collect(reader.readStream(actor, scope, turnId, 5))).toBe(terminal('completed', 5))
})

test('http_rejects_invalid_parameters_and_missing_identity_before_sse', async () => {
  const { reader } = setup()
  const http = createStreamHttp(reader)
  const request = { httpMethod: 'GET', resource: streamRoute, pathParameters: { scopeId: scope, turnId }, requestId: 'fixture-request' }
  for (const cursor of ['-1', '1.2', '1e1', '', '9007199254740992']) {
    const result = await http({ ...request, queryStringParameters: { after: cursor } }, actor)
    expect(result).toMatchObject({ statusCode: 400 })
    expect(JSON.parse(await collect(result.body))).toMatchObject({ code: 'INVALID_REQUEST', requestId: 'fixture-request' })
  }
  expect((await http({ ...request, multiValueQueryStringParameters: { after: ['1','2'] } }, actor)).statusCode).toBe(400)
  expect((await http({ ...request, pathParameters: {scopeId: 'á'.repeat(129), turnId} }, actor)).statusCode).toBe(400)
  expect((await http(request, undefined)).statusCode).toBe(401)
  expect((await http({ ...request, httpMethod: 'POST' }, actor)).statusCode).toBe(404)
  const ok = await http({ ...request, queryStringParameters: { after: '5' } }, actor)
  expect(ok).toMatchObject({ statusCode: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
  expect(await collect(ok.body)).toBe(terminal('completed', 5))
})

test('deadline_consumed_by_a_read_drops_the_batch_before_emission', async () => {
  const { reader, blocks } = setup()
  const now = vi.spyOn(Date, 'now')
  const start = Date.now()
  try {
    blocks.mockImplementationOnce(async () => {
      now.mockReturnValue(start + 121)
      return [event(3)]
    })
    expect(await collect(reader.readStream(actor, scope, turnId, 2))).toBe('')
  } finally { now.mockRestore() }
})

test('gateway_identity_requires_verified_claims_and_an_existing_session', async () => {
  const { Writable } = await import('node:stream')
  const { DynamoDBDocumentClient, GetCommand, TransactGetCommand } = await import('@aws-sdk/lib-dynamodb')
  type Metadata = { statusCode: number }
  const preludes = new WeakMap<InstanceType<typeof Writable>, Metadata>()
  let expireBeforeFirstWrite: (() => void) | undefined
  vi.stubEnv('ARTURIA_CLIENT_ID', 'fixture-client')
  vi.stubEnv('ARTURIA_TABLE_NAME', 'fixture-table')
  vi.stubGlobal('awslambda', {
    streamifyResponse: (handler: unknown) => handler,
    HttpResponseStream: { from(out: InstanceType<typeof Writable>, value: Metadata) { preludes.set(out, value); return out } },
  })
  let enrolled = false
  const db = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command: unknown) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key
      if (key?.pk === 'SUBJECT' && key.sk === 'fixture-sub') return { Item: { userId: actor.userId } }
      if (key?.pk === JSON.stringify([actor.userId]) && key.sk === 'SESSION#' + actor.sessionId) {
        return enrolled ? { Item: { status: 'active', authTime: 2 } } : {}
      }
    }
    if (command instanceof TransactGetCommand) {
      expireBeforeFirstWrite?.()
      expect(command.input.TransactItems?.map(i => i.Get?.Key?.sk)).toEqual([
        'ACCOUNT', 'SESSION#' + actor.sessionId, 'SCOPE', 'TURN#' + turnId,
      ])
      return { Responses: [{ status: 'active', mfaVerifiedAt: 1 }, { status: 'active', authTime: 2 },
        { actions: new Set(['turn:stream']) }, { status: 'completed', lastSeq: 0 }].map(Item => ({ Item })) }
    }
    throw new Error('Unexpected database access')
  })
  try {
    const { handler } = await import('./stream.lambda.js')
    const claims = { client_id: 'fixture-client', token_use: 'access', scope: 'arturia/access', sub: 'fixture-sub',
      origin_jti: actor.sessionId, auth_time: '2', exp: Math.floor(Date.now() / 1_000) + 300 }
    const invoke = async (verified?: Record<string, string | number>) => {
      const pieces: string[] = []
      let status: number | undefined
      const output = new Writable({ write(chunk, _, done) {
        status ??= preludes.get(output)?.statusCode
        pieces.push(chunk.toString())
        done()
      } })
      const request = { httpMethod: 'GET', resource: streamRoute, pathParameters: { scopeId: scope, turnId },
        headers: { Authorization: 'Bearer fake.fake.fake' }, requestContext: { requestId: 'fixture-http', authorizer: { claims: verified } } }
      await handler(request, output, { getRemainingTimeInMillis: () => 24_000 })
      return { status, body: pieces.join('') }
    }
    for (const invalid of [undefined, { ...claims, client_id: 'other' }, { ...claims, token_use: 'id' },
      { ...claims, scope: 'arturia/access-extra' }, { ...claims, exp: 0 }]) {
      expect(await invoke(invalid)).toMatchObject({ status: 401 })
    }
    expect(db).not.toHaveBeenCalled()
    expect(await invoke(claims)).toMatchObject({ status: 401 })
    enrolled = true
    expect(await invoke({ ...claims, auth_time: 1 })).toMatchObject({ status: 401 })
    expect(await invoke(claims)).toEqual({ status: 200, body: terminal('completed', 0) })
    const clock = vi.spyOn(Date, 'now')
    const expired = Date.now() + 24_000
    expireBeforeFirstWrite = () => clock.mockReturnValue(expired)
    try {
      expect(await invoke(claims)).toEqual({ status: 200, body: '' })
    } finally {
      clock.mockRestore()
    }
  } finally {
    db.mockRestore()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }
})

test.each(['TransactionConflict', 'ValidationError'])('snapshot retry for %s', async code => {
  const client = new DynamoDBClient({})
  const store = new ChatStore(client, 'fixture-table')
  const failure = new TransactionCanceledException({
    message: code, $metadata: {}, CancellationReasons: [{ Code: 'None' }, { Code: code }],
  })
  const send = vi.spyOn(store.db, 'send').mockRejectedValueOnce(failure).mockImplementationOnce(async () => ({
    Responses: [
      { Item: { status: 'active', mfaVerifiedAt: 1 } },
      { Item: { status: 'active', authTime: 2 } },
      { Item: { actions: new Set(['turn:stream']) } },
      { Item: { status: 'completed', lastSeq: 0 } },
    ],
  }))
  try {
    const { readStream } = createStreamReader(dynamoStreamSource(store))
    const result = collect(readStream(actor, scope, turnId, 0))
    if (code === 'TransactionConflict') {
      await expect(result).resolves.toBe(terminal('completed', 0))
      expect(send).toHaveBeenCalledTimes(2)
    } else {
      await expect(result).rejects.toBe(failure)
      expect(send).toHaveBeenCalledTimes(1)
    }
  } finally {
    client.destroy()
  }
})
