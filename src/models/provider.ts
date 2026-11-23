// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

export interface ProviderRequest {
  readonly attemptId: string
  readonly text: string
  readonly signal: AbortSignal
}

export interface ProviderEvent { readonly type: 'text'; readonly text: string }

export interface Provider {
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>
}

// Adapters use this when transport failed without a definitive provider outcome.
export class UncertainSend extends Error {}

