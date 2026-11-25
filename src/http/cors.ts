// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// CORS for the browser client: one exact HTTPS origin, never a wildcard and no credentials.

type Environment = Readonly<Record<string, string | undefined>>

const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
/** Whole-value pattern, also used as the CloudFormation `AllowedPattern` of the origin parameter. */
export const ALLOWED_ORIGIN_PATTERN = `https://${label}(?:\\.${label})+(?::[0-9]{1,5})?`
const origin = new RegExp(`^${ALLOWED_ORIGIN_PATTERN}$`)

export const CORS_ORIGIN_VARIABLE = 'ARTURIA_ALLOWED_ORIGIN'
export const CORS = {
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  maxAgeSeconds: 600,
} as const

export function isAllowedOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || !origin.test(value)) return false
  const port = value.match(/:(\d+)$/)?.[1]
  return port === undefined || Number(port) <= 65_535
}

export const readAllowedOrigin = (env: Environment) => {
  const value = env[CORS_ORIGIN_VARIABLE]
  return isAllowedOrigin(value) ? value : undefined
}

export function corsHeaders(allowed: string): Record<string, string> {
  if (!isAllowedOrigin(allowed)) throw new RangeError('Invalid CORS origin')
  return { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' }
}
