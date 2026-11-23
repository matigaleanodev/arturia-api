// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { ModelEvent, ModelOutbound, ModelTransport } from './dispatch.js'
import { ModelPolicyDenied, UncertainSend } from './provider.js'

type WireRequest = {
  readonly provider: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}

// The caller supplies a single POST with no redirects or retries. There is no default network client.
export type ModelWire = (request: WireRequest) => Promise<Response>
type Payload = Record<string, unknown>

const bodyLimit = 8 * 1024 * 1024
const frameLimit = 1024 * 1024
export const maxOutputTokens = 128_000
export const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

export function record(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model event')
  return value as Payload
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid model event')
  return value
}

export function count(value: unknown): number {
  if (!isCount(value)) throw new Error('Invalid model usage')
  return value
}

export function tool(id: unknown, name: unknown, args: unknown): ModelEvent {
  return { type: 'tool', id: string(id), name: string(name), arguments: record(args) }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted)
      reject(new Error('Model stream aborted'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

async function* events(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let line = ''
  let skipLF = false
  let data = ''
  while (true) {
    signal.throwIfAborted()
    const { done, value } = await abortable(reader.read(), signal)
    if (done) {
      decoder.decode()
      return
    }
    size += value.byteLength
    if (size > bodyLimit) throw new Error('Model stream exceeds byte limit')
    const chunk = decoder.decode(value, { stream: true })
    for (const character of chunk) {
      if (skipLF && character === '\n') { skipLF = false; continue }
      skipLF = character === '\r'
      if (character !== '\r' && character !== '\n') {
        line += character
        if (line.length > frameLimit) throw new Error('Model stream line exceeds limit')
        continue
      }
      if (line.startsWith('data:')) {
        data += line.slice(5).replace(/^ /, '') + '\n'
        if (data.length > frameLimit) throw new Error('Model event exceeds limit')
      } else if (!line && data) {
        signal.throwIfAborted()
        if (data === '[DONE]\n') return
        yield record(JSON.parse(data))
        data = ''
      }
      line = ''
    }
  }
}

interface Protocol {
  readonly provider: string
  readonly model: string
  readonly contextWindow: number
  readonly minOutputTokens: number
  readonly rejectedBeforeGeneration?: readonly number[]
  readonly path: string
  readonly headers?: Record<string, string>
  build(request: ModelOutbound): Payload
  normalize(events: AsyncIterable<Payload>): AsyncIterable<ModelEvent>
}

export function createAdapter(protocol: Protocol, wire: ModelWire, timeoutMs: number): ModelTransport {
  if (!isCount(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000) throw new ModelPolicyDenied('Invalid model timeout')
  return {
    inputTokenBound(_text, model) {
      if (model !== protocol.model) throw new ModelPolicyDenied('Unsupported model')
      // The model context window bounds accepted requests, including provider-added framing.
      return protocol.contextWindow
    },
    async *stream(request) {
      const { limits } = request
      if (request.provider !== protocol.provider || request.model !== protocol.model ||
          !isCount(limits.outputTokens) || limits.outputTokens < protocol.minOutputTokens || limits.outputTokens > maxOutputTokens ||
          limits.reasoningTokens !== 0 || limits.toolTokens !== 0 || limits.toolCalls !== 0) {
        throw new ModelPolicyDenied('Invalid model attempt configuration')
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([request.signal, controller.signal])
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let response: Response | undefined
      try {
        signal.throwIfAborted()
        const pending = wire({
          provider: protocol.provider, path: protocol.path, signal,
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...protocol.headers },
          body: JSON.stringify(protocol.build(request)),
        }).then(result => {
          if (signal.aborted) void result.body?.cancel().catch(() => {})
          return result
        })
        response = await abortable(pending, signal)
        signal.throwIfAborted()
        if (response.status === 401 || protocol.rejectedBeforeGeneration?.includes(response.status)) {
          yield { type: 'usage', failed: true,
            usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } }
          return
        }
        if (response.status !== 200 || !response.body ||
            response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
          throw new Error('Invalid model response')
        }
        reader = response.body.getReader()
        let emittedOutput = false
        for await (const event of protocol.normalize(events(reader, signal))) {
          signal.throwIfAborted()
          if (event.type === 'usage') {
            const { usage } = event
            const totalOutput = usage.outputTokens + usage.reasoningTokens + usage.toolTokens
            if (emittedOutput && (usage.outputTokens === 0 || event.noCharge)) throw new Error('Inconsistent model usage')
            if (usage.inputTokens > protocol.contextWindow || totalOutput > limits.outputTokens || usage.toolCalls) {
              yield { ...event, failed: true }
            } else yield event
            return
          }
          emittedOutput ||= event.type === 'tool' || event.text.length > 0
          yield event
        }
        throw new Error('Missing terminal model usage')
      } catch {
        throw new UncertainSend('Model charge unconfirmed')
      } finally {
        clearTimeout(timeout)
        if (reader) {
          void reader.cancel().catch(() => {})
          reader.releaseLock()
        } else if (response) {
          void response.body?.cancel().catch(() => {})
        }
        controller.abort()
      }
    },
  }
}
