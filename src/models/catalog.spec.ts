// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { costMicros, type Tariff } from './budget.js'
import { MAX_INPUT_BYTES, ModelBoundError, checkCalibration, inputTokenBound, type InputCalibration } from './budget-bound.js'
import { PILOT_MAX_OUTPUT_TOKENS, catalogInputBound, checkCatalogConfig as checkConfig } from './catalog.js'
import { ModelPolicyDenied } from './provider.js'

const usd = 1_000_000
const base = { verifiedAt: Date.UTC(2025, 0), expiresAt: Date.UTC(2040, 0), toolCall: 0 }
const tariffs: Record<string, Tariff> = {
  openai: { ...base, inputPerMillion: 200_000, outputPerMillion: 750_000,
    shortContext: { maxInputTokens: 272_000, inputPerMillion: 100_000, outputPerMillion: 500_000 } },
  anthropic: { ...base, inputPerMillion: 2_000_000, outputPerMillion: 10_000_000 },
}
const models = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' }
const checkCatalogConfig = (...args: Parameters<typeof checkConfig>) => checkConfig(...args)!
const selection = (provider: 'openai' | 'anthropic', maxOutputTokens = 64) => ({
  enabled: true, provider, model: models[provider], maxOutputTokens, tariff: tariffs[provider],
})

test('cap_below_attempt_bound_is_config_error', () => {
  const bound = costMicros(tariffs.anthropic, { inputTokens: 1_000_000, outputTokens: 4096, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 })
  expect(bound).toBe(2_040_960)
  // A US$ 2 provider cap cannot hold even one Sonnet attempt: an explicit error, not a silent rejection per send.
  expect(() => checkCatalogConfig(selection('anthropic', 4096), { anthropic: 2 * usd }, {})).toThrow(ModelBoundError)
  expect(() => checkCatalogConfig(selection('anthropic', 4096), { anthropic: 2 * usd }, {})).toThrow(/anthropic/)
  expect(() => checkCatalogConfig(selection('anthropic', 4096), { anthropic: bound - 1 }, {})).toThrow(ModelBoundError)
  expect(checkCatalogConfig(selection('anthropic', 4096), { anthropic: bound }, {})).toMatchObject({ attemptBoundMicros: bound, maxReservations: 1 })
})

test('cap_missing_or_invalid_is_config_error', () => {
  for (const caps of [{}, { anthropic: Number.NaN }, { anthropic: -1 }, { anthropic: 1.5 * usd + 0.5 }, { anthropic: Infinity }] as Record<string, number>[]) {
    expect(() => checkCatalogConfig(selection('anthropic'), caps, {}), JSON.stringify(caps)).toThrow(ModelBoundError)
  }
})

test('us_6_cap_documents_how_many_uncertain_attempts_block_the_month', () => {
  expect(checkCatalogConfig(selection('anthropic', 4096), { anthropic: 6 * usd }, {})).toMatchObject({
    provider: 'anthropic', attemptBoundMicros: 2_040_960, effectiveCapMicros: 6 * usd, maxReservations: 2 })
  // The global US$ 10 cap also bounds the effective cap.
  expect(checkCatalogConfig(selection('anthropic', 4096), { anthropic: 50 * usd }, {})).toMatchObject({
    effectiveCapMicros: 10 * usd, maxReservations: 4 })
  expect(checkCatalogConfig(selection('openai', 4096), { openai: 6 * usd }, {})).toMatchObject({
    attemptBoundMicros: 213_072, maxReservations: 28 })
})

test('pilot_output_cap_reduces_reservation', () => {
  expect(PILOT_MAX_OUTPUT_TOKENS).toMatchObject({ 'gpt-6-luna': 4096, 'claude-sonnet-5-5': 4096 })
  const caps = { anthropic: 50 * usd }
  // Default environment is the pilot: fail closed on a larger output.
  expect(() => checkCatalogConfig(selection('anthropic', 4097), caps, {})).toThrow(ModelPolicyDenied)
  expect(() => checkCatalogConfig(selection('anthropic', 4097), caps, { environment: 'pilot' })).toThrow(ModelPolicyDenied)
  const pilot = checkCatalogConfig(selection('anthropic', 4096), caps, { environment: 'pilot' })
  const full = checkCatalogConfig(selection('anthropic', 128_000), caps, { environment: 'production' })
  expect(pilot.attemptBoundMicros).toBeLessThan(full.attemptBoundMicros)
  expect(full.attemptBoundMicros - pilot.attemptBoundMicros).toBe((128_000 - 4096) * 10)
  // Output limits never exceed the wire maximum, even in production.
  expect(() => checkCatalogConfig(selection('anthropic', 128_001), caps, { environment: 'production' })).toThrow(ModelPolicyDenied)
})

const calibration = (over: Partial<InputCalibration> = {}): InputCalibration => ({
  framingTokens: 64, source: 'provider-token-count-fixture',
  samples: [{ bytes: 10, tokens: 4 }, { bytes: 1000, tokens: 700 }, { bytes: 5, tokens: 5 }], ...over,
})

test('byte_bound_disabled_without_calibration', () => {
  const window = 1_000_000
  expect(inputTokenBound(window, 10)).toBe(window)
  expect(inputTokenBound(window, 10, undefined)).toBe(window)
  // The catalog uses the context window of the model when no calibration is configured.
  expect(catalogInputBound('hola', 'claude-sonnet-5-5', {})).toBe(1_000_000)
  expect(catalogInputBound('hola', 'gpt-6-luna', {})).toBe(1_050_000)
  // A calibration for another model never applies.
  expect(catalogInputBound('hola', 'claude-sonnet-5-5', { calibration: { 'gpt-6-luna': calibration() } })).toBe(1_000_000)
})

test('byte_bound_never_below_measured_tokens', () => {
  expect(() => checkCalibration(calibration())).not.toThrow()
  // A measured sample above bytes + framing makes the whole calibration invalid.
  expect(() => checkCalibration(calibration({ samples: [{ bytes: 10, tokens: 75 }] }))).toThrow(ModelBoundError)
  expect(() => checkCalibration(calibration({ samples: [{ bytes: 10, tokens: 74 }] }))).not.toThrow()
  for (const bad of [{ samples: [] }, { framingTokens: -1 }, { framingTokens: 1.5 }, { source: '' },
    { samples: [{ bytes: 0, tokens: 1 }] }, { samples: [{ bytes: 1.5, tokens: 1 }] }, { samples: [{ bytes: 1, tokens: -1 }] }]) {
    expect(() => checkCalibration(calibration(bad)), JSON.stringify(bad)).toThrow(ModelBoundError)
  }
  const bytes = Buffer.byteLength('áéíóú 🙂', 'utf8')
  expect(inputTokenBound(1_000_000, bytes, calibration())).toBe(bytes + 64)
  // Never above the window, and never below the measured samples.
  expect(inputTokenBound(100, 1000, calibration())).toBe(100)
  for (const { bytes: b, tokens } of calibration().samples) expect(inputTokenBound(1_000_000, b, calibration())).toBeGreaterThanOrEqual(tokens)
  // An invalid calibration reaching the catalog fails instead of being ignored.
  expect(() => catalogInputBound('hola', 'claude-sonnet-5-5', { calibration: { 'claude-sonnet-5-5': calibration({ samples: [{ bytes: 1, tokens: 900 }] }) } }))
    .toThrow(ModelBoundError)
  expect(catalogInputBound('hola', 'claude-sonnet-5-5', { calibration: { 'claude-sonnet-5-5': calibration() } })).toBe(4 + 64)
})

test('input_over_the_byte_limit_is_denied_before_any_reservation', () => {
  expect(MAX_INPUT_BYTES).toBe(393_216)
  expect(() => catalogInputBound('a'.repeat(MAX_INPUT_BYTES + 1), 'gpt-6-luna', {})).toThrow(ModelPolicyDenied)
  expect(() => catalogInputBound('a'.repeat(MAX_INPUT_BYTES), 'gpt-6-luna', {})).not.toThrow()
  // Multibyte text is measured in UTF-8 bytes, not code units.
  expect(() => catalogInputBound('é'.repeat(MAX_INPUT_BYTES / 2 + 1), 'gpt-6-luna', {})).toThrow(ModelPolicyDenied)
})

test('calibrated_bound_reduces_the_config_bound_for_the_largest_input', () => {
  const caps = { anthropic: 50 * usd }
  const plain = checkCatalogConfig(selection('anthropic', 4096), caps, {})
  const calibrated = checkCatalogConfig(selection('anthropic', 4096), caps,
    { calibration: { 'claude-sonnet-5-5': calibration() } })
  // Worst accepted input: MAX_INPUT_BYTES + framing tokens instead of the whole 1 M window.
  expect(calibrated.attemptBoundMicros).toBe(costMicros(tariffs.anthropic,
    { inputTokens: MAX_INPUT_BYTES + 64, outputTokens: 4096, reasoningTokens: 0, toolTokens: 0, toolCalls: 0 }))
  expect(calibrated.attemptBoundMicros).toBeLessThan(plain.attemptBoundMicros)
})
