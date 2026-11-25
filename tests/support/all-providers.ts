// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { createCatalogTurnProvider as create } from '../../src/models/catalog.js'

/** Both providers of the catalog, so the Anthropic path stays covered while the runtime keeps it disabled. */
export const ALL_PROVIDERS = ['openai', 'anthropic'] as const

/** `createCatalogTurnProvider` with every catalog provider enabled. The runtime default enables only OpenAI. */
export function createCatalogTurnProvider(...args: Parameters<typeof create>): ReturnType<typeof create> {
  const [store, budget, select, wire, options] = args
  return create(store, budget, select, wire, { providers: ALL_PROVIDERS, ...options })
}
