// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { ChatStore } from '../chat/turns.store.js'
import { costMicros, ModelBudget, tariffSnapshot, type Tariff, type Usage } from './budget.js'
import { safeModelText, type ModelContext } from './egress.js'
import { currentTurnContext } from './policy.js'
import { ModelPolicyDenied, UncertainSend, type Provider, type ProviderEvent } from './provider.js'

type Limits = Omit<Usage, 'inputTokens'>
type Operation = 'chat' | 'tool' | 'extraction' | 'automation'
interface Configuration {
  readonly provider: string
  readonly model: string
  readonly tariff?: Tariff
  readonly limits: Limits
}
interface Outbound {
  readonly provider: string
  readonly model: string
  readonly attemptId: string
  readonly text: string
  readonly limits: Limits
  readonly signal: AbortSignal
}
export interface ModelTransport {
  // Pure verified upper bound for the complete adapter request, including framing and tool schemas.
  inputTokenBound(text: string, model: string): number
  // Single transport attempt. The adapter enforces the quoted limits and disables SDK retries.
  stream(request: Outbound): AsyncIterable<ProviderEvent | { type: 'usage'; usage: Usage }>
}

// Background callers supply a backend reader that reconstructs the authorized minimum from current
// identity, job/resource grants, provenance and scope. Never accept this closure or pricing from HTTP.
interface Job {
  readonly attemptId: string
  readonly userId: string
  readonly scopeId: string
  readonly operation: Operation
  readonly signal: AbortSignal
  readAuthorizedContext(provider: string): Promise<ModelContext>
}

export async function* dispatchModel(budget: ModelBudget, now: () => Date, configure: () => Configuration,
  transport: ModelTransport, job: Job): AsyncGenerator<ProviderEvent> {
  const options = () => {
    const config = configure()
    if (!config.model || !config.provider) throw new ModelPolicyDenied('Missing model configuration')
    const { outputTokens, reasoningTokens, toolTokens, toolCalls } = config.limits
    return { model: config.model, provider: config.provider, limits: { outputTokens, reasoningTokens, toolTokens, toolCalls },
      tariff: tariffSnapshot(config.tariff, now().getTime()) }
  }
  const initial = options()
  const { provider, model, limits, tariff } = initial
  const text = safeModelText(await job.readAuthorizedContext(provider))
  const maxCost = costMicros(tariff, { ...limits, inputTokens: transport.inputTokenBound(text, model) })
  job.signal.throwIfAborted()
  const receipt = await budget.reserveAttempt(job.attemptId, job.userId, job.scopeId, provider, maxCost,
    { model, operation: job.operation, tariff })
  if (!receipt.allowed) throw new ModelPolicyDenied('Model attempt not authorized')
  try {
    const current = safeModelText(await job.readAuthorizedContext(provider))
    const currentOptions = options()
    if (receipt.month !== now().toISOString().slice(0, 7) || text !== current ||
        JSON.stringify(initial) !== JSON.stringify(currentOptions)) throw new ModelPolicyDenied('Model context changed')
    job.signal.throwIfAborted()
  } catch (error) {
    // This process won the unique reservation and has not called the transport.
    await budget.settleAttempt(job.attemptId, { kind: 'invoice', costMicros: 0 })
    throw error
  }

  let usage: Usage | undefined
  try {
    for await (const event of transport.stream({ attemptId: job.attemptId, provider, model, text, signal: job.signal, limits })) {
      if (usage) throw new Error('Unexpected event after final usage')
      if (event.type === 'usage') usage = event.usage
      else if (event.type === 'text') yield event
      else throw new Error('Unexpected model event')
    }
    if (!usage) throw new Error('Missing final model usage')
    await budget.settleAttempt(job.attemptId, { kind: 'reported', usage })
  } catch {
    // Cancellation, partial streams, missing billing information, and network errors preserve
    // the full reservation. Never expose raw adapter errors (they may echo the prompt).
    throw new UncertainSend('Model charge unconfirmed')
  }
}

export function createTurnDispatcher(store: ChatStore, budget: ModelBudget, configure: () => Configuration,
  transport: ModelTransport): Provider {
  return { stream: request => dispatchModel(budget, store.now, configure, transport, {
    attemptId: request.attemptId, userId: request.ref.userId, scopeId: request.ref.scopeId,
    operation: 'chat', signal: request.signal, readAuthorizedContext: provider => currentTurnContext(store, request, provider),
  }) }
}
