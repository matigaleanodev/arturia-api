// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { TurnReference } from '../chat/turns.types.js'

export interface ProviderRequest {
  readonly ref: TurnReference
  readonly leaseId: string
  readonly sessionId: string
  readonly messageSk: string
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


// A preflight policy check denied the attempt before the transport was called.
export class ModelPolicyDenied extends Error {}
