// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { readSmokeConfig, runSseSmoke } from '../../src/smoke/sse-smoke.js'

const TURN = '11111111-2222-4333-8444-555555555555'
const sse = (...frames: string[]) => new Response(new ReadableStream({ start(c) {
  for (const frame of frames) c.enqueue(new TextEncoder().encode(frame)); c.close() } }),
{ status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
const text = (seq: number) => `event: text\ndata: ${JSON.stringify({ type: 'text', turnId: TURN, seq, text: 'b' + seq })}\n\n`
const status = (s: string, lastSeq?: number) => `event: status\ndata: ${JSON.stringify({ type: 'status', turnId: TURN, status: s, ...(lastSeq === undefined ? {} : { lastSeq }) })}\n\n`

function scripted(streams: (() => Response)[], stepMs: number) {
  const urls: string[] = []
  const sleeps: number[] = []
  let clock = 0
  const fake = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    if (init?.method === 'POST' && url.endsWith('/conversations')) return Response.json({ conversationId: 'c1' }, { status: 201 })
    if (init?.method === 'POST') return Response.json({ turnId: TURN, status: 'queued' }, { status: 202 })
    if (url.includes('/events')) { clock += stepMs; return streams.shift()!() }
    return Response.json({ status: 'completed', lastSeq: 3 })
  }) as typeof fetch
  const lines: string[] = []
  const config = readSmokeConfig({ ARTURIA_SMOKE_API_URL: 'https://api.example.test/v1', ARTURIA_SMOKE_ACCESS_TOKEN: 'x'.repeat(32) })
  const run = () => runSseSmoke(config, { fetch: fake, now: () => clock, out: line => lines.push(line), sleep: async ms => { sleeps.push(ms) } })
  return { urls, sleeps, lines, run }
}

test('smoke_resumes_with_a_cursor_even_after_an_empty_first_connection', async () => {
  // Cold start: the first connection closes (24 s in AWS) before any block exists.
  const { urls, sleeps, lines, run } = scripted([
    () => sse(status('queued'), ': keep-alive\n\n'),
    () => sse(text(1), text(2)),
    () => sse(text(2), text(3), status('completed', 3)),
  ], 1_000)
  const code = await run()
  expect(lines.at(-1)).toBeDefined()
  expect(code, lines.join('\n')).toBe(0)
  const events = urls.filter(url => url.includes('/events')).map(url => new URL(url).searchParams.get('after'))
  // The cut happens on the first block, wherever it arrives, and the next connection resumes after it.
  expect(events).toEqual(['0', '0', '1'])
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, blocks: 3, reconnections: 2 })
  // A connection that closed by itself is retried after a pause that respects the SSE throttle (1 rps).
  expect(sleeps).toEqual([1_000])
})

test('blocks arriving together with the terminal fail the first-block-before-terminal check', async () => {
  // 100 ms between connections: the terminal follows the first block by far less than 500 ms.
  const { lines, run } = scripted([() => sse(text(1)), () => sse(text(2), text(3), status('completed', 3))], 100)
  expect(await run()).toBe(1)
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: false, blocks: 3, failures: ['el primer bloque no llegó antes del terminal'] })
})
