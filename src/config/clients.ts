// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SSMClient } from '@aws-sdk/client-ssm'
import { TIMING, type Timing } from './timing.js'

type Persistence = Pick<Timing, 'persistenceConnectTimeoutMs' | 'persistenceRequestTimeoutMs' | 'persistenceMaxAttempts'>

/**
 * DynamoDB client options of every Lambda. The SDK default has no request timeout and several attempts, so
 * a degraded table could hold an invocation until Lambda ends it. The bounds come from `TIMING`, whose
 * invariants keep three worst-case operations inside the worker closing margin. Fails closed on invalid values.
 */
export function dynamoClientConfig(timing: Persistence = TIMING) {
  const { persistenceConnectTimeoutMs, persistenceRequestTimeoutMs, persistenceMaxAttempts } = timing
  if (![persistenceConnectTimeoutMs, persistenceRequestTimeoutMs, persistenceMaxAttempts].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new RangeError('Persistence timeouts and attempts must be positive integers')
  }
  return { maxAttempts: persistenceMaxAttempts,
    // Without `throwOnRequestTimeout` this SDK only logs a warning when the request timeout elapses.
    requestHandler: { connectionTimeout: persistenceConnectTimeoutMs, requestTimeout: persistenceRequestTimeoutMs, throwOnRequestTimeout: true } }
}

export const createDynamoClient = (timing: Persistence = TIMING) => new DynamoDBClient(dynamoClientConfig(timing))

/** Parameter Store client of the worker, with the same bounded timeouts and attempts as the persistence clients. */
export const createParameterClient = (timing: Persistence = TIMING) => new SSMClient(dynamoClientConfig(timing))
