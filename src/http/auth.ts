// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { ResolveActor } from '../identity/actor.js'

export async function resolveHttpActor(resolveActor: ResolveActor, authorization?: string | null) {
  const token = authorization?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i)?.[1]
  return token ? resolveActor(token) : undefined
}
