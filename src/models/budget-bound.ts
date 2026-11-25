// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { MONTHLY_CAP, costMicros, type Tariff } from './budget.js'

/** Largest accepted message: the contract allows 393216 UTF-8 bytes, the same limit the turn store enforces. */
export const MAX_INPUT_BYTES = 384 * 1024

/** Invalid cost or input bounds. A configuration error, never a per-request rejection. */
export class ModelBoundError extends Error { override name = 'ModelBoundError' }

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * Evidence that tokens never exceed `bytes + framingTokens` for this model, measured with the provider's own
 * token counter. Without it the context window is the only trustworthy input bound.
 */
export interface InputCalibration {
  /** Tokens the provider adds around the text (roles, wrappers). */
  readonly framingTokens: number
  /** Opaque reference to the measurement (no content). */
  readonly source: string
  /** Provider-counted samples: UTF-8 bytes of the text and tokens the provider reported. */
  readonly samples: readonly { readonly bytes: number; readonly tokens: number }[]
}

/** Rejects a calibration whose own samples contradict it: a bound below a measured count is never valid. */
export function checkCalibration(calibration: InputCalibration): InputCalibration {
  const { framingTokens, source, samples } = calibration
  if (!count(framingTokens) || typeof source !== 'string' || !source || !Array.isArray(samples) || !samples.length ||
      !samples.every(s => count(s?.bytes) && s.bytes > 0 && count(s?.tokens))) {
    throw new ModelBoundError('Invalid input calibration')
  }
  if (samples.some(s => s.tokens > s.bytes + framingTokens)) throw new ModelBoundError('Input calibration below a measured token count')
  return calibration
}

/** Input token bound for a request: the context window, or bytes plus framing once a valid calibration exists. */
export function inputTokenBound(window: number, bytes: number, calibration?: InputCalibration): number {
  if (!calibration) return window
  checkCalibration(calibration)
  return Math.min(window, bytes + calibration.framingTokens)
}

export interface AttemptBoundInput {
  readonly provider: string
  readonly model: string
  readonly tariff: Tariff
  /** Worst-case input tokens of one attempt. */
  readonly inputTokens: number
  /** Output cap sent to the provider (it covers visible output and reasoning). */
  readonly outputTokens: number
}
export interface AttemptBoundReport {
  readonly provider: string
  readonly model: string
  readonly attemptBoundMicros: number
  readonly capMicros: number
  readonly effectiveCapMicros: number
  /** Uncertain attempts (each keeps its full reservation) that exhaust the month for this provider. */
  readonly maxReservations: number
}

/**
 * A provider cap below the cost bound of a single attempt would reject every send silently. Fail closed
 * and visibly instead: the cap must be a valid amount and hold at least one attempt.
 */
export function checkProviderCap(input: AttemptBoundInput, caps: Readonly<Record<string, number>>, monthlyCap = MONTHLY_CAP): AttemptBoundReport {
  const { provider, model, tariff, inputTokens, outputTokens } = input
  const capMicros = Object.hasOwn(caps, provider) ? caps[provider] : Number.NaN
  if (!count(capMicros)) throw new ModelBoundError(`Missing or invalid spending cap for provider ${provider}`)
  const attemptBoundMicros = costMicros(tariff, { inputTokens, outputTokens, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 })
  const effectiveCapMicros = Math.min(monthlyCap, capMicros)
  if (attemptBoundMicros > effectiveCapMicros) {
    throw new ModelBoundError(`Spending cap of provider ${provider} (${effectiveCapMicros} micros) is below the bound of one ${model} attempt (${attemptBoundMicros} micros)`)
  }
  return { provider, model, attemptBoundMicros, capMicros, effectiveCapMicros,
    maxReservations: Math.floor(effectiveCapMicros / attemptBoundMicros) }
}
