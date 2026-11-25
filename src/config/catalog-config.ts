// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Pure rules of the billable `catalog` mode. This module has no imports on purpose: the runtime, the Lambda bundle
// and the CDK app (which Node runs without a build) all read the same definitions.

/** The one secret that holds the provider keys. The foundation grants read access to this name only. */
export const PROVIDER_SECRET_NAME = 'arturia-pilot/providers'
export const PROVIDER_SECRET_VARIABLE = 'ARTURIA_PROVIDER_SECRET_ARN'

const arnPattern = new RegExp(
  `^arn:aws:secretsmanager:[a-z]{2}(?:-[a-z]+)+-\\d:\\d{12}:secret:${PROVIDER_SECRET_NAME.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}-[A-Za-z0-9]{6}$`)

/** Full ARN (with the six random characters) of the fixed secret name, commercial partition only. */
export const isProviderSecretArn = (value: unknown): value is string => typeof value === 'string' && arnPattern.test(value)

/** Models the catalog can serve. A test keeps this list equal to the catalog itself. */
export const CATALOG_MODELS: readonly string[] = Object.freeze(['gpt-6-luna', 'claude-sonnet-5-5'])

/**
 * Providers the runtime may use. A provider outside this list is implemented and tested but disabled: it has no
 * credential, no transport, no spending cap and no selectable model. Enabling one is a code change, never environment.
 */
export const ENABLED_PROVIDERS: readonly string[] = Object.freeze(['openai'])

/** Models of the enabled providers. A test keeps it consistent with the catalog and the enabled providers. */
export const ENABLED_CATALOG_MODELS: readonly string[] = Object.freeze(['gpt-6-luna'])

/** A tariff verification is good for 90 days. After that the deployment fails closed until it is verified again. */
export const TARIFF_MAX_AGE_DAYS = 90

/** A real calendar date (YYYY-MM-DD), not in the future and not older than the verification window. */
export function isFreshDay(value: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value + 'T00:00:00Z')
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) return false
  const age = (now.getTime() - time) / 86_400_000
  return age >= 0 && age <= TARIFF_MAX_AGE_DAYS
}
