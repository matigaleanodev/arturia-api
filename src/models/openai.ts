// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { TIMING } from '../config/timing.js'
import { count, createAdapter, record, string, tool, type ModelWire } from './wire.js'

export const openAIMinOutputTokens = 16

export const openAIContextWindow = 1_050_000

export function createOpenAIAdapter(wire: ModelWire, timeoutMs = TIMING.transportTimeoutSeconds * 1000) {
  return createAdapter({
    provider: 'openai',
    model: 'gpt-6-luna',
    contextWindow: openAIContextWindow,
    minOutputTokens: openAIMinOutputTokens,
    path: '/v1/responses',
    build: ({ model, text, limits }) => ({
      model, input: text, stream: true, store: false, max_output_tokens: limits.outputTokens,
      service_tier: 'default', prompt_cache_options: { mode: 'explicit' },
    }),
    async *normalize(events) {
      let refused = false
      for await (const event of events) {
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'text', text: string(event.delta) }
            break
          case 'response.refusal.delta':
          case 'response.refusal.done':
            refused = true
            break
          case 'response.output_item.done': {
            const item = record(event.item)
            if (item.type === 'function_call' && item.status === 'completed') {
              yield tool(item.call_id, item.name, JSON.parse(string(item.arguments)))
            }
            break
          }
          case 'response.completed':
          case 'response.failed':
          case 'response.incomplete': {
            const response = record(event.response)
            if (event.type !== 'response.' + response.status) throw new Error('Invalid model terminal status')
            const usage = record(response.usage)
            const inputTokens = count(usage.input_tokens)
            const inputDetails = record(usage.input_tokens_details ?? {})
            if (count(inputDetails.cache_write_tokens ?? 0) || count(inputDetails.cached_tokens ?? 0) ||
                (response.service_tier !== undefined && response.service_tier !== 'default')) {
              throw new Error('Unquoted model usage')
            }
            const output = count(usage.output_tokens)
            const reasoningTokens = count(record(usage.output_tokens_details).reasoning_tokens)
            if (reasoningTokens > output) throw new Error('Invalid reasoning usage')
            yield { type: 'usage', ...(response.status !== 'completed' || refused ? { failed: true } : {}),
              usage: { inputTokens, outputTokens: output - reasoningTokens, reasoningTokens, toolTokens: 0, toolCalls: 0 } }
            return
          }
          case 'error':
          case 'response.cancelled':
            throw new Error('Model stream interrupted')
        }
      }
    },
  }, wire, timeoutMs)
}
