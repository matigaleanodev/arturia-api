// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { setTimeout as delay } from 'node:timers/promises'
import type { Provider, ProviderRequest } from './provider.js'

export class SimulatedProvider implements Provider {
  constructor(private readonly chunks: readonly string[] = ['Hola, ', 'este es un resultado sintético.'],
    private readonly intervalMs = 0) {}

  async *stream({ signal }: ProviderRequest) {
    for (const text of this.chunks) {
      if (this.intervalMs) await delay(this.intervalMs, undefined, { signal })
      signal.throwIfAborted()
      yield { type: 'text' as const, text }
    }
  }
}

