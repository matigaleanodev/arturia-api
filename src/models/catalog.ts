// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { TIMING } from '../config/timing.js'
import type { ChatStore } from '../chat/turns.store.js'
import { anthropicContextWindow, createAnthropicAdapter } from './anthropic.js'
import type { ModelBudget, Tariff } from './budget.js'
import { MAX_INPUT_BYTES, ModelBoundError, checkProviderCap, inputTokenBound, type AttemptBoundReport, type InputCalibration } from './budget-bound.js'
import { createTurnDispatcher, type ModelTransport } from './dispatch.js'
import { createOpenAIAdapter, openAIContextWindow, openAIMinOutputTokens } from './openai.js'
import { ModelPolicyDenied } from './provider.js'
import { isCount, maxOutputTokens, type ModelWire } from './wire.js'

export interface ModelSelection {
  readonly enabled: boolean
  readonly provider: string
  readonly model: string
  readonly maxOutputTokens: number
  readonly tariff?: Tariff
}

export interface CatalogOptions {
  /** Transport timeout of the adapters. Must stay below the worker provider deadline. */
  readonly timeoutMs?: number
  /** The pilot caps the output of each model lower than the wire maximum. Fails closed: the default is `pilot`. */
  readonly environment?: 'pilot' | 'production'
  /** Provider-measured input bounds per model. Without one, the context window is the bound. */
  readonly calibration?: Readonly<Record<string, InputCalibration>>
}

// Floors in microdollars per million for the supported uncached standard request.
const catalog = [
  { provider: 'openai', model: 'gpt-6-luna', input: 200_000, output: 750_000,
    minOutputTokens: openAIMinOutputTokens, contextWindow: openAIContextWindow, pilotMaxOutputTokens: 4096,
    shortContext: { maxInputTokens: 272_000, input: 100_000, output: 500_000 } },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', input: 2_000_000, output: 10_000_000,
    minOutputTokens: 1, contextWindow: anthropicContextWindow, pilotMaxOutputTokens: 4096 },
] as const
type Entry = typeof catalog[number]

/** Largest output a model may be configured with in the pilot, keyed by model. */
export const PILOT_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> =
  Object.freeze(Object.fromEntries(catalog.map(entry => [entry.model, entry.pilotMaxOutputTokens])))

const candidate = (model: string): Entry => {
  const match = catalog.find(entry => entry.model === model)
  if (!match) throw new ModelPolicyDenied('Unsupported model')
  return match
}
const calibrationOf = (model: string, options: Pick<CatalogOptions, 'calibration'>) =>
  options.calibration && Object.hasOwn(options.calibration, model) ? options.calibration[model] : undefined

/**
 * Input bound of one request: refuses text above the contract limit, then uses the model context window,
 * or the calibrated bytes-plus-framing bound when evidence for this model exists.
 */
export function catalogInputBound(text: string, model: string, options: Pick<CatalogOptions, 'calibration'>): number {
  const entry = candidate(model)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_INPUT_BYTES) throw new ModelPolicyDenied('Model input too large')
  return inputTokenBound(entry.contextWindow, bytes, calibrationOf(model, options))
}

function validateSelection(selected: ModelSelection, options: CatalogOptions) {
  const { provider, model, tariff, maxOutputTokens: outputTokens } = selected
  const allowed = candidate(model)
  const pilot = (options.environment ?? 'pilot') === 'pilot'
  if (allowed.provider !== provider || !isCount(outputTokens) || outputTokens < allowed.minOutputTokens || outputTokens > maxOutputTokens ||
      (pilot && outputTokens > allowed.pilotMaxOutputTokens) ||
      !tariff || tariff.inputPerMillion < allowed.input || tariff.outputPerMillion < allowed.output || tariff.toolCall !== 0) {
    throw new ModelPolicyDenied('Invalid model selection')
  }
  if ('shortContext' in allowed) {
    const band = tariff.shortContext
    if (!band || band.maxInputTokens !== allowed.shortContext.maxInputTokens ||
        band.inputPerMillion < allowed.shortContext.input || band.outputPerMillion < allowed.shortContext.output) {
      throw new ModelPolicyDenied('Invalid short-context rate')
    }
  } else if (tariff.shortContext !== undefined) throw new ModelPolicyDenied('Unexpected short-context rate')
  return { allowed, provider, model, tariff, outputTokens }
}

/**
 * Validates a model selection against the spending caps. A cap below the bound of one attempt is a
 * configuration error (`ModelBoundError`), reported once at startup instead of rejecting every send.
 * Returns the bound of the largest accepted request and how many uncertain attempts exhaust the month.
 * A disabled or absent selection has nothing to check.
 */
export function checkCatalogConfig(selected: ModelSelection | undefined, caps: Readonly<Record<string, number>>,
  options: CatalogOptions = {}): AttemptBoundReport | undefined {
  if (selected?.enabled !== true) return undefined
  const { allowed, provider, model, tariff, outputTokens } = validateSelection(selected, options)
  const inputTokens = inputTokenBound(allowed.contextWindow, MAX_INPUT_BYTES, calibrationOf(model, options))
  return checkProviderCap({ provider, model, tariff, inputTokens, outputTokens }, caps)
}

export function createCatalogTurnProvider(store: ChatStore, budget: ModelBudget, select: () => ModelSelection | undefined,
  wire: ModelWire, options: CatalogOptions = {}) {
  const timeoutMs = options.timeoutMs ?? TIMING.transportTimeoutSeconds * 1000
  // The worker aborts at the provider deadline; the transport must give up first.
  if (!isCount(timeoutMs) || timeoutMs < 1 || timeoutMs >= TIMING.providerTimeoutSeconds * 1000) {
    throw new ModelBoundError('Transport timeout must be below the provider deadline')
  }
  const adapters = { openai: createOpenAIAdapter(wire, timeoutMs), anthropic: createAnthropicAdapter(wire, timeoutMs) }
  const transport: ModelTransport = {
    inputTokenBound: (text, model) => catalogInputBound(text, model, options),
    stream: request => adapters[candidate(request.model).provider].stream(request),
  }
  return createTurnDispatcher(store, budget, () => {
    const selected = select()
    if (selected?.enabled !== true) throw new ModelPolicyDenied('Model disabled')
    const { provider, model, tariff, outputTokens } = validateSelection(selected, options)
    // A cap below the bound of this attempt is refused by the reservation, before anything is sent. The
    // composition reports it explicitly once at startup with `checkCatalogConfig`.
    // Both APIs cap visible output and reasoning together. No extra reasoning or tool budget is needed.
    return { provider, model, tariff, limits: { outputTokens, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 } }
  }, transport)
}
