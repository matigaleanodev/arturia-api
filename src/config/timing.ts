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
 *
 * Closing margin: after the provider deadline the worker still performs the final flush and the terminal
 * write, and an operation already started when the deadline passes (a lease poll or a flush) can still be
 * running. Each persistence operation is bounded by the SDK (connect and request timeouts, a bounded number
 * of attempts), so three operations in their worst case, plus a slack, must fit in the margin. The margin is best effort: if DynamoDB is degraded past it, Lambda ends the invocation and
 * the turn stays `uncertain` until its lease expires, which never produces a second provider call.
 * The transport timeout (adapter) is below the provider deadline of the worker, so the adapter aborts
 * its own request first and the worker deadline only closes what the adapter could not.
 */
export interface Timing {
  readonly providerTimeoutSeconds: number
  /** Timeout of the model transport (adapter); below the provider deadline and at most the adapter maximum. */
  readonly transportTimeoutSeconds: number
  /** Connect timeout of each DynamoDB request. */
  readonly persistenceConnectTimeoutMs: number
  /** Request (socket) timeout of each DynamoDB request. */
  readonly persistenceRequestTimeoutMs: number
  /** SDK attempts per DynamoDB operation. Transactions reuse their client request token across attempts. */
  readonly persistenceMaxAttempts: number
  /** Operation in flight at the deadline, final flush and terminal write, after the provider deadline. */
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
/** Largest timeout the model adapters accept. */
export const ADAPTER_MAX_TIMEOUT_SECONDS = 45
/** Allowance for the SDK backoff between two attempts of one operation. */
export const PERSISTENCE_BACKOFF_ALLOWANCE_MS = 500
/** Allowance for the policy re-read and scheduling around the final flush and terminal write. */
export const PERSISTENCE_SLACK_MS = 1000

/** Worst-case duration of one DynamoDB operation: every attempt times out, plus the backoff between attempts. */
export const persistenceOperationMs = (t: Pick<Timing, 'persistenceConnectTimeoutMs' | 'persistenceRequestTimeoutMs' | 'persistenceMaxAttempts'>) =>
  t.persistenceMaxAttempts * (t.persistenceConnectTimeoutMs + t.persistenceRequestTimeoutMs) +
  (t.persistenceMaxAttempts - 1) * PERSISTENCE_BACKOFF_ALLOWANCE_MS

export function checkTiming(t: Timing): Timing {
  const broken: string[] = []
  const rule = (ok: boolean, message: string) => { if (!ok) broken.push(message) }
  for (const [name, value] of Object.entries(t)) rule(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
  rule(t.providerTimeoutSeconds + t.closeMarginSeconds < t.workerTimeoutSeconds, 'provider timeout plus margin must be below the worker timeout')
  rule(t.transportTimeoutSeconds < t.providerTimeoutSeconds, 'transport timeout must be below the provider timeout')
  rule(t.transportTimeoutSeconds <= ADAPTER_MAX_TIMEOUT_SECONDS, 'transport timeout cannot exceed the adapter maximum')
  rule(3 * persistenceOperationMs(t) + PERSISTENCE_SLACK_MS <= t.closeMarginSeconds * 1000,
    'three persistence operations in their worst case must fit in the closing margin')
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
  transportTimeoutSeconds: 40,
  persistenceConnectTimeoutMs: 500,
  persistenceRequestTimeoutMs: 1000,
  persistenceMaxAttempts: 2,
  closeMarginSeconds: 12,
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
