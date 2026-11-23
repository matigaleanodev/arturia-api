// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { ChatStore } from '../chat/turns.store.js'
import { createAnthropicAdapter } from './anthropic.js'
import type { ModelBudget, Tariff } from './budget.js'
import { createTurnDispatcher, type ModelTransport } from './dispatch.js'
import { createOpenAIAdapter, openAIMinOutputTokens } from './openai.js'
import { ModelPolicyDenied } from './provider.js'
import { isCount, maxOutputTokens, type ModelWire } from './wire.js'

interface ModelSelection {
  readonly enabled: boolean
  readonly provider: string
  readonly model: string
  readonly maxOutputTokens: number
  readonly tariff?: Tariff
}

export function createCatalogTurnProvider(store: ChatStore, budget: ModelBudget, select: () => ModelSelection | undefined,
  wire: ModelWire, timeoutMs?: number) {
  const catalog = [
    // Floors in microdollars per million for the supported uncached standard request.
    { provider: 'openai', model: 'gpt-6-luna', input: 200_000, output: 750_000,
      minOutputTokens: openAIMinOutputTokens, shortContext: { maxInputTokens: 272_000, input: 100_000, output: 500_000 },
      adapter: createOpenAIAdapter(wire, timeoutMs) },
    { provider: 'anthropic', model: 'claude-sonnet-5-5', input: 2_000_000, output: 10_000_000,
      minOutputTokens: 1, adapter: createAnthropicAdapter(wire, timeoutMs) },
  ]
  const candidate = (model: string) => {
    const match = catalog.find(entry => entry.model === model)
    if (!match) throw new ModelPolicyDenied('Unsupported model')
    return match
  }
  const transport: ModelTransport = {
    inputTokenBound: (text, model) => candidate(model).adapter.inputTokenBound(text, model),
    stream: request => candidate(request.model).adapter.stream(request),
  }
  return createTurnDispatcher(store, budget, () => {
    const selected = select()
    if (selected?.enabled !== true) throw new ModelPolicyDenied('Model disabled')
    const { provider, model, tariff, maxOutputTokens: outputTokens } = selected
    const allowed = candidate(model)
    if (allowed.provider !== provider || !isCount(outputTokens) || outputTokens < allowed.minOutputTokens || outputTokens > maxOutputTokens ||
        !tariff || tariff.inputPerMillion < allowed.input || tariff.outputPerMillion < allowed.output || tariff.toolCall !== 0) {
      throw new ModelPolicyDenied('Invalid model selection')
    }
    if (allowed.shortContext) {
      const band = tariff.shortContext
      if (!band || band.maxInputTokens !== allowed.shortContext.maxInputTokens ||
          band.inputPerMillion < allowed.shortContext.input || band.outputPerMillion < allowed.shortContext.output) {
        throw new ModelPolicyDenied('Invalid short-context rate')
      }
    } else if (tariff.shortContext !== undefined) throw new ModelPolicyDenied('Unexpected short-context rate')
    // Both APIs cap visible output and reasoning together. No extra reasoning or tool budget is needed.
    return { provider, model, tariff, limits: { outputTokens, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } }
  }, transport)
}
