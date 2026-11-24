// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

/**
 * Single source of the durations shared by the worker code and the CDK composition.
 *
 * Invariant: provider timeout + closing margin < worker timeout <= lease, and the turn queue
 * visibility exceeds worker timeout + lease, because the lease starts when an invocation claims the
 * turn, at most one worker timeout after the receive. A redelivery therefore always finds an expired
 * lease and resolves it instead of consuming another receive. AWS also asks for a visibility of at
 * least six times the function timeout on SQS event sources (no batching window on standard FIFO
 * event sources).
 */
export interface Timing {
  readonly providerTimeoutSeconds: number
  /** Reads before the provider call plus the final flush and terminal write. */
  readonly closeMarginSeconds: number
  readonly workerTimeoutSeconds: number
  readonly leaseSeconds: number
  readonly turnVisibilitySeconds: number
  readonly turnMaxReceives: number
  readonly turnRetentionDays: number
  /** SQS event source maximum concurrency (AWS minimum: 2). Replaces reserved concurrency. */
  readonly workerMaxConcurrency: number
  readonly relayTimeoutSeconds: number
  readonly sseFunctionTimeoutSeconds: number
  readonly sseIntegrationTimeoutSeconds: number
  /** Buffered HTTP handler, below the default REST integration timeout of 29 s. */
  readonly httpFunctionTimeoutSeconds: number
}

const LAMBDA_MAX_SECONDS = 900
const SQS_MAX_VISIBILITY_SECONDS = 43_200
const REST_INTEGRATION_TIMEOUT_SECONDS = 29

export function checkTiming(t: Timing): Timing {
  const broken: string[] = []
  const rule = (ok: boolean, message: string) => { if (!ok) broken.push(message) }
  for (const [name, value] of Object.entries(t)) rule(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
  rule(t.providerTimeoutSeconds + t.closeMarginSeconds < t.workerTimeoutSeconds, 'provider timeout plus margin must be below the worker timeout')
  rule(t.workerTimeoutSeconds <= LAMBDA_MAX_SECONDS && t.relayTimeoutSeconds <= LAMBDA_MAX_SECONDS, 'Lambda timeouts cannot exceed 900 s')
  rule(t.workerTimeoutSeconds <= t.leaseSeconds, 'lease must cover the worker timeout')
  rule(t.workerTimeoutSeconds + t.leaseSeconds < t.turnVisibilitySeconds, 'visibility must exceed worker timeout plus lease')
  rule(t.turnVisibilitySeconds >= 6 * t.workerTimeoutSeconds, 'visibility must be at least six worker timeouts')
  rule(t.turnVisibilitySeconds <= SQS_MAX_VISIBILITY_SECONDS, 'visibility cannot exceed 43200 s')
  rule(t.turnMaxReceives >= 5 && t.turnMaxReceives <= 1000, 'max receives must be between 5 and 1000')
  rule(t.turnRetentionDays <= 14, 'retention cannot exceed 14 days')
  rule(t.workerMaxConcurrency >= 2 && t.workerMaxConcurrency <= 1000, 'worker max concurrency must be between 2 and 1000')
  rule(t.sseFunctionTimeoutSeconds < t.sseIntegrationTimeoutSeconds, 'SSE function timeout must be below its integration timeout')
  rule(t.httpFunctionTimeoutSeconds < REST_INTEGRATION_TIMEOUT_SECONDS, 'HTTP function timeout must be below 29 s')
  if (broken.length) throw new RangeError('Invalid timing: ' + broken.join('; '))
  return t
}

export const TIMING: Timing = checkTiming({
  providerTimeoutSeconds: 45,
  closeMarginSeconds: 10,
  workerTimeoutSeconds: 60,
  leaseSeconds: 75,
  turnVisibilitySeconds: 360,
  turnMaxReceives: 5,
  turnRetentionDays: 14,
  workerMaxConcurrency: 2,
  relayTimeoutSeconds: 30,
  sseFunctionTimeoutSeconds: 28,
  sseIntegrationTimeoutSeconds: 29,
  httpFunctionTimeoutSeconds: 10,
})
