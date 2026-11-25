// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { ARTURIA_ACCESS_SCOPE, type ResolveActor } from '../identity/actor.js'

export async function resolveHttpActor(resolveActor: ResolveActor, authorization?: string | null) {
  const token = authorization?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i)?.[1]
  return token ? resolveActor(token) : undefined
}

export interface GatewayClaims {
  readonly sub: string
  readonly origin_jti: string
  readonly auth_time: number
  readonly exp: number
}

// REST passes numeric claims as strings. Accept only plain non-negative integers.
const integer = (value: unknown) => typeof value === 'number' ? value :
  typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const utcDate = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC (\d{4})$/
// The REST Cognito authorizer may render date claims as `Thu Feb 04 21:04:44 UTC 2021`. Parse that
// exact UTC form into epoch seconds and reject any date that does not round-trip.
function epochSeconds(value: unknown) {
  const match = typeof value === 'string' ? utcDate.exec(value) : null
  if (!match) return integer(value)
  const [, day, month, date, hours, minutes, seconds, year] = match
  const time = Date.UTC(Number(year), months.indexOf(month), Number(date), Number(hours), Number(minutes), Number(seconds))
  const parsed = new Date(time)
  if (days[parsed.getUTCDay()] !== day || parsed.getUTCDate() !== Number(date) || parsed.getUTCHours() !== Number(hours) ||
      parsed.getUTCMinutes() !== Number(minutes) || parsed.getUTCSeconds() !== Number(seconds)) return Number.NaN
  return time / 1_000
}

/**
 * REST's scoped Cognito authorizer verifies the access token signature and issuer. Only these trusted
 * requestContext claims, for this app client and with the Arturia scope, may select an actor.
 */
export function gatewayClaims(claims: Record<string, unknown> | null | undefined, clientId: string): GatewayClaims | undefined {
  if (!claims || !clientId || claims.client_id !== clientId || claims.token_use !== 'access' ||
      typeof claims.scope !== 'string' || !claims.scope.split(' ').includes(ARTURIA_ACCESS_SCOPE)) return
  const { sub, origin_jti } = claims
  const exp = epochSeconds(claims.exp)
  const auth_time = integer(claims.auth_time)
  if (typeof sub !== 'string' || !sub.trim() || typeof origin_jti !== 'string' || !origin_jti.trim() ||
      !Number.isSafeInteger(exp) || !Number.isSafeInteger(auth_time) || auth_time < 1) return
  return { sub, origin_jti, auth_time, exp }
}
