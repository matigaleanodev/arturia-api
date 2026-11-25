// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { catalogFloor, type ModelSelection } from './catalog.js'

/**
 * Spending cap per enabled provider in microdollars, below the US$ 10 monthly cap. A provider without a cap cannot
 * reserve anything, so a disabled provider has no budget even if something selected it.
 */
export const PROVIDER_CAPS: Readonly<Record<string, number>> = Object.freeze({ openai: 6_000_000 })

const DAY_MS = 86_400_000
/** A tariff verification is good for 90 days. After that the deployment fails closed until it is verified again. */
export const TARIFF_VALIDITY_DAYS = 90

/**
 * The model selection of the `catalog` mode: the documented floor rates of the catalog, the pilot output cap and a
 * verification window starting at the date the operator verified the official tariff. Rates and caps are code, not
 * environment: only the model and the verification date come from the deployment.
 */
export function catalogSelectionFor(model: string, verifiedAt: string, _now: Date = new Date()): ModelSelection {
  const floor = catalogFloor(model)
  const start = Date.parse(verifiedAt + 'T00:00:00Z')
  return {
    enabled: true, provider: floor.provider, model, maxOutputTokens: floor.pilotMaxOutputTokens,
    tariff: {
      verifiedAt: start, expiresAt: start + TARIFF_VALIDITY_DAYS * DAY_MS,
      inputPerMillion: floor.input, outputPerMillion: floor.output, toolCall: 0,
      ...(floor.shortContext && { shortContext: { maxInputTokens: floor.shortContext.maxInputTokens,
        inputPerMillion: floor.shortContext.input, outputPerMillion: floor.shortContext.output } }),
    },
  }
}
