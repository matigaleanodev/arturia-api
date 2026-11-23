// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { inject } from 'vitest'

interface LocalDatabase {
  endpoint: string
  tableName: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabase: LocalDatabase
  }
}

export function localDynamoClient(endpoint: string) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint)) {
    throw new Error('DynamoDB tests require an explicit IPv4 loopback endpoint')
  }
  return new DynamoDBClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'ArturiaLocal', secretAccessKey: 'synthetic-local-only' },
    maxAttempts: 1,
  })
}

export function integrationDatabase() {
  const local = inject('integrationDatabase')
  if (!local) throw new Error('The integration project did not provision DynamoDB Local')
  return { tableName: local.tableName, client: localDynamoClient(local.endpoint) }
}
