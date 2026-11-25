// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { ModelPolicyDenied } from './provider.js'
import { CATALOG_MODELS } from '../config/catalog-config.js'
import { PILOT_MAX_OUTPUT_TOKENS, checkCatalogConfig } from './catalog.js'
import { PROVIDER_CAPS, catalogSelectionFor } from './catalog-runtime.js'

const now = new Date('2026-11-25T12:00:00Z')

test('catalog_selection_uses_the_documented_floors_and_expires', () => {
  const luna = catalogSelectionFor('gpt-6-luna', '2026-11-20', now)
  expect(luna).toMatchObject({ enabled: true, provider: 'openai', model: 'gpt-6-luna', maxOutputTokens: 4096 })
  expect(luna.tariff).toMatchObject({ inputPerMillion: 200_000, outputPerMillion: 750_000, toolCall: 0,
    shortContext: { maxInputTokens: 272_000, inputPerMillion: 100_000, outputPerMillion: 500_000 } })
  expect(luna.tariff!.verifiedAt).toBe(Date.parse('2026-11-20T00:00:00Z'))
  // The verification is good for 90 days from its date, never longer.
  expect(luna.tariff!.expiresAt).toBe(Date.parse('2026-11-20T00:00:00Z') + 90 * 86_400_000)
  const sonnet = catalogSelectionFor('claude-sonnet-5-5', '2026-11-20', now)
  expect(sonnet.tariff).toMatchObject({ inputPerMillion: 2_000_000, outputPerMillion: 10_000_000 })
  expect(sonnet.tariff!.shortContext).toBeUndefined()
  expect(() => catalogSelectionFor('gpt-4', '2026-11-20', now)).toThrow(ModelPolicyDenied)
})

test('catalog_caps_hold_one_attempt_of_each_model_and_stay_below_the_monthly_cap', () => {
  expect(PROVIDER_CAPS).toEqual({ openai: 6_000_000, anthropic: 6_000_000 })
  for (const model of ['gpt-6-luna', 'claude-sonnet-5-5']) {
    const report = checkCatalogConfig(catalogSelectionFor(model, '2026-11-20', now), PROVIDER_CAPS)
    expect(report).toBeDefined()
  }
})

test('catalog_models_list_matches_the_catalog', () => {
  expect([...CATALOG_MODELS].sort()).toEqual(Object.keys(PILOT_MAX_OUTPUT_TOKENS).sort())
})
