// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { localDynamoClient } from './local-database.ts'
import { inject } from 'vitest'

export { localDynamoClient } from './local-database.ts'

interface LocalDatabase {
  endpoint: string
  tableName: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabase: LocalDatabase
  }
}

export function integrationDatabase() {
  const local = inject('integrationDatabase')
  if (!local) throw new Error('The integration project did not provision DynamoDB Local')
  return { tableName: local.tableName, client: localDynamoClient(local.endpoint) }
}
