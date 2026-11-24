// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { ConfigError } from '../config/runtime.js'
import type { Provider } from './provider.js'
import { SimulatedProvider } from './simulated.js'

export const FIXTURE_BLOCKS: readonly string[] = ['Primer bloque sintético. ', 'Segundo bloque sintético. ', 'Tercer bloque sintético.']
export const FIXTURE_INTERVAL_MS = 1_000

/**
 * Deployable non-billable behaviour, accepted only in the pilot environment. `stream` emits three
 * blocks one interval apart. `fail` never runs the turn so the queue redelivers it until the DLQ.
 */
export type PilotFixture = { readonly kind: 'stream'; readonly provider: Provider } | { readonly kind: 'fail' }

export function pilotFixture(runtime: { readonly environment: string; readonly providerMode: string },
  intervalMs = FIXTURE_INTERVAL_MS): PilotFixture {
  if (runtime.environment !== 'pilot') throw new ConfigError(['ARTURIA_ENVIRONMENT'])
  if (runtime.providerMode === 'fixture') return { kind: 'stream', provider: new SimulatedProvider(FIXTURE_BLOCKS, intervalMs) }
  if (runtime.providerMode === 'fail') return { kind: 'fail' }
  throw new ConfigError(['ARTURIA_PROVIDER_MODE'])
}
