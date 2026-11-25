// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { createDynamoClient, dynamoClientConfig } from './clients.js'
import { TIMING } from './timing.js'

test('dynamo_client_has_bounded_timeouts_and_attempts', async () => {
  expect(dynamoClientConfig()).toEqual({ maxAttempts: TIMING.persistenceMaxAttempts,
    requestHandler: { connectionTimeout: TIMING.persistenceConnectTimeoutMs, requestTimeout: TIMING.persistenceRequestTimeoutMs,
      throwOnRequestTimeout: true } })
  const client = createDynamoClient()
  try {
    expect(await client.config.maxAttempts()).toBe(TIMING.persistenceMaxAttempts)
    // The handler configuration resolves lazily. A request timeout that is not thrown is only a warning.
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> }
    expect(await handler.configProvider).toMatchObject({ throwOnRequestTimeout: true,
      connectionTimeout: TIMING.persistenceConnectTimeoutMs, requestTimeout: TIMING.persistenceRequestTimeoutMs })
  } finally { client.destroy() }
})

test('dynamo_client_rejects_unbounded_overrides', () => {
  expect(() => dynamoClientConfig({ ...TIMING, persistenceMaxAttempts: 0 })).toThrow(RangeError)
  expect(() => dynamoClientConfig({ ...TIMING, persistenceRequestTimeoutMs: 0 })).toThrow(RangeError)
})
