// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { count, createAdapter, record, string, tool, type ModelWire } from './wire.js'

export function createAnthropicAdapter(wire: ModelWire, timeoutMs = 40_000) {
  return createAdapter({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    contextWindow: 1_000_000,
    minOutputTokens: 1,
    rejectedBeforeGeneration: [413],
    path: '/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    build: ({ model, text, limits }) => ({
      model, messages: [{ role: 'user', content: text }], stream: true, max_tokens: limits.outputTokens,
    }),
    async *normalize(events) {
      let usage: Record<string, unknown> | undefined
      let stop: string | undefined
      let refusalCategory: unknown
      let startedContent = false
      let outputTokens: number | undefined
      let block: { index: number; payload: Record<string, unknown>; json: string } | undefined
      for await (const event of events) {
        if (event.type === 'ping') continue
        if (event.type === 'message_start') {
          if (usage) throw new Error('Repeated model stream start')
          usage = record(record(event.message).usage)
          count(usage.input_tokens)
          continue
        }
        if (!usage) throw new Error('Missing model stream start')
        switch (event.type) {
          case 'content_block_start': {
            if (block || stop) throw new Error('Unexpected model block')
            startedContent = true
            const payload = record(event.content_block)
            block = { index: count(event.index), payload, json: '' }
            if (payload.type === 'text' && payload.text !== '') yield { type: 'text', text: string(payload.text) }
            break
          }
          case 'content_block_delta': {
            if (!block || block.index !== event.index) throw new Error('Unexpected model block')
            const delta = record(event.delta)
            if (block.payload.type === 'text' && delta.type === 'text_delta') {
              yield { type: 'text', text: string(delta.text) }
            } else if (block.payload.type === 'tool_use' && delta.type === 'input_json_delta') {
              block.json += string(delta.partial_json)
            }
            break
          }
          case 'content_block_stop':
            if (!block || block.index !== event.index) throw new Error('Unexpected model block')
            if (block.payload.type === 'tool_use') {
              yield tool(block.payload.id, block.payload.name, block.json ? JSON.parse(block.json) : block.payload.input)
            }
            block = undefined
            break
          case 'message_delta': {
            if (block) throw new Error('Unfinished model block')
            const delta = record(event.delta)
            const reason = delta.stop_reason
            if (delta.stop_details && typeof delta.stop_details === 'object') {
              refusalCategory = record(delta.stop_details).category
            }
            if (reason !== null && reason !== undefined) {
              if (stop && stop !== reason) throw new Error('Conflicting model stop reason')
              stop = string(reason)
            }
            const latest = record(event.usage)
            for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
              if (latest[field] !== undefined && count(latest[field]) < count(usage[field] ?? 0)) {
                throw new Error('Non-cumulative model usage')
              }
            }
            if (latest.output_tokens !== undefined) outputTokens = count(latest.output_tokens)
            usage = { ...usage, ...latest }
            break
          }
          case 'message_stop': {
            if (!stop || outputTokens === undefined || block) throw new Error('Missing terminal usage')
            if (usage.server_tool_use || count(usage.cache_creation_input_tokens ?? 0)) {
              throw new Error('Unquoted model usage')
            }
            const inputTokens = count(count(usage.input_tokens) + count(usage.cache_read_input_tokens ?? 0))
            const details = record(usage.output_tokens_details ?? {})
            const reasoningTokens = count(details.thinking_tokens ?? 0)
            if (reasoningTokens > outputTokens) throw new Error('Invalid thinking usage')
            const noCharge = stop === 'refusal' && !startedContent && outputTokens === 0 &&
              (refusalCategory === null || refusalCategory === 'cyber' || refusalCategory === 'general_harms')
            yield { type: 'usage', ...(['end_turn', 'stop_sequence', 'tool_use'].includes(stop) ? {} : { failed: true }),
              ...(noCharge ? { noCharge: true } : {}),
              usage: { inputTokens, outputTokens: outputTokens - reasoningTokens, reasoningTokens, toolTokens: 0, toolCalls: 0 } }
            return
          }
          case 'error':
            throw new Error('Model stream interrupted')
        }
      }
    },
  }, wire, timeoutMs)
}
