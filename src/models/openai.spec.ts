// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { createAnthropicAdapter } from './anthropic.js'
import { createOpenAIAdapter } from './openai.js'
import { ModelPolicyDenied, UncertainSend } from './provider.js'
import type { ModelWire } from './wire.js'

const input = {
  provider: 'openai', model: 'gpt-6-luna', text: 'Entrada sintética', attemptId: 'fixture-attempt',
  limits: { outputTokens: 64, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 },
  signal: new AbortController().signal,
}
const fixture = (name: string): unknown[] =>
  JSON.parse(readFileSync(new URL('../../contracts/fixtures/providers/' + name + '.json', import.meta.url), 'utf8'))
async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = []
  for await (const event of stream) events.push(event)
  return events
}

function reply(events: unknown[]) {
  const bytes = Buffer.from(events.map(event => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.subarray(offset, offset + 3))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

test('openai_normalizes_text_tool_usage_and_error', async () => {
  const wire = vi.fn<ModelWire>(async () => reply(fixture('openai')))
  expect(await collect(createOpenAIAdapter(wire).stream(input))).toEqual([
    { type: 'text', text: '¡Hola!' },
    { type: 'tool', id: 'call_fixture', name: 'weather', arguments: { city: 'Mar del Plata' } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 6, reasoningTokens: 4, toolTokens: 0, toolCalls: 0 } },
  ])
  wire.mockImplementation(async () => reply([{
    type: 'response.failed', response: { status: 'failed', error: { message: 'fixture-credential' },
      usage: { input_tokens: 2, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } } },
  }]))
  expect(await collect(createOpenAIAdapter(wire).stream(input))).toEqual([
    { type: 'usage', failed: true, usage: { inputTokens: 2, outputTokens: 0, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } },
  ])
})

test('store_disabled_in_requests', async () => {
  const wire = vi.fn<ModelWire>(async () => reply(fixture('openai')))
  await collect(createOpenAIAdapter(wire).stream(input))
  const [request] = wire.mock.calls[0]
  expect(request.path).toBe('/v1/responses')
  expect(JSON.parse(request.body)).toEqual({
    model: input.model, input: input.text, stream: true, store: false, max_output_tokens: 64,
    service_tier: 'default', prompt_cache_options: { mode: 'explicit' },
  })
  expect(wire).toHaveBeenCalledTimes(1)
})

test('bytes_after_partial_error_never_restart', async () => {
  const wire = vi.fn<ModelWire>(async () => reply([
    fixture('openai')[0], { type: 'error', message: 'fixture-credential' }, fixture('openai').at(-1),
  ]))
  const iter = createOpenAIAdapter(wire).stream(input)[Symbol.asyncIterator]()
  expect(await iter.next()).toEqual({ done: false, value: { type: 'text', text: '¡Hola!' } })
  await expect(iter.next()).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(wire).toHaveBeenCalledTimes(1)
})

test('Anthropic normalizes complete tool arguments and cumulative output', async () => {
  const wire = vi.fn<ModelWire>(async () => reply(fixture('anthropic')))
  const request = { ...input, provider: 'anthropic', model: 'claude-sonnet-5-5' }
  expect(await collect(createAnthropicAdapter(wire).stream(request))).toEqual([
    { type: 'text', text: 'Claude' },
    { type: 'tool', id: 'tool_fixture', name: 'weather', arguments: { city: 'Mendoza' } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 9, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } },
  ])
  expect(wire.mock.calls[0][0]).toMatchObject({ path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' } })
  expect(JSON.parse(wire.mock.calls[0][0].body)).toEqual({
    model: request.model, messages: [{ role: 'user', content: request.text }], stream: true, max_tokens: 64,
  })
})

test('invalid limits and mismatched models never cross the transport boundary', async () => {
  const wire = vi.fn<ModelWire>()
  const adapter = createOpenAIAdapter(wire)
  for (const request of [{ ...input, model: 'invalid' }, { ...input, limits: { ...input.limits, toolCalls: 1 } }]) {
    await expect(collect(adapter.stream(request))).rejects.toBeInstanceOf(ModelPolicyDenied)
  }
  expect(wire).not.toHaveBeenCalled()
})

test('caller cancellation closes an open body without waiting for the remote stream', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const controller = new AbortController()
  const wire = vi.fn<ModelWire>(async () => new Response(new ReadableStream({
    start(remote) { remote.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"parcial"}\n\n')) },
    cancel,
  }), { headers: { 'content-type': 'text/event-stream' } }))
  const iter = createOpenAIAdapter(wire).stream({ ...input, signal: controller.signal })[Symbol.asyncIterator]()
  expect((await iter.next()).value).toEqual({ type: 'text', text: 'parcial' })
  const pending = iter.next()
  controller.abort(new Error('private cancellation reason'))
  await expect(pending).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('adapter deadline bounds a transport that never resolves', async () => {
  const wire = vi.fn<ModelWire>(() => new Promise(() => {}))
  await expect(collect(createOpenAIAdapter(wire, 10).stream(input))).rejects.toThrow(UncertainSend)
  expect(wire.mock.calls[0][0].signal.aborted).toBe(true)
  expect(wire).toHaveBeenCalledTimes(1)
})

test('Anthropic separates billed thinking from visible output', async () => {
  const wire = vi.fn<ModelWire>(async () => reply([
    { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {
      output_tokens: 348, output_tokens_details: { thinking_tokens: 312 },
    } },
    { type: 'message_stop' },
  ]))
  const request = { ...input, provider: 'anthropic', model: 'claude-sonnet-5-5', limits: { ...input.limits, outputTokens: 400 } }
  expect(await collect(createAnthropicAdapter(wire).stream(request))).toEqual([
    { type: 'usage', usage: { inputTokens: 25, outputTokens: 36, reasoningTokens: 312, toolTokens: 0, toolCalls: 0 } },
  ])
})

test.each([401, 413])('Anthropic rejection HTTP %i confirms the attempt did not run', async status => {
  const wire = vi.fn<ModelWire>(async () => new Response('private provider error', { status }))
  const request = { ...input, provider: 'anthropic', model: 'claude-sonnet-5-5' }
  expect(await collect(createAnthropicAdapter(wire).stream(request))).toEqual([
    { type: 'usage', failed: true, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } },
  ])
  expect(wire).toHaveBeenCalledTimes(1)
})

test('does not settle a zero-output receipt after visible text', async () => {
  const wire = vi.fn<ModelWire>(async () => reply([fixture('openai')[0], {
    type: 'response.completed', response: { status: 'completed',
      usage: { input_tokens: 12, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } } },
  }]))
  await expect(collect(createOpenAIAdapter(wire).stream(input))).rejects.toThrow(UncertainSend)
  expect(wire).toHaveBeenCalledTimes(1)
})

test('OpenAI rejects unquoted cache writes and ambiguous HTTP errors without retrying', async () => {
  const wire = vi.fn<ModelWire>()
  wire.mockResolvedValueOnce(reply([{
    type: 'response.completed', response: { status: 'completed', usage: {
      input_tokens: 12, input_tokens_details: { cache_write_tokens: 3 },
      output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 },
    } },
  }])).mockResolvedValueOnce(new Response('fixture-credential', { status: 503 }))
  const adapter = createOpenAIAdapter(wire)
  await expect(collect(adapter.stream(input))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  await expect(collect(adapter.stream(input))).rejects.toThrow(new UncertainSend('Model charge unconfirmed'))
  expect(wire).toHaveBeenCalledTimes(2)
})
