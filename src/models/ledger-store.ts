// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { ChatStore } from '../chat/turns.store.js'
import { loadLedgerRuntime } from '../config/runtime.js'
import { ModelBudget } from './budget.js'

/**
 * Store of the AI consumption ledger: budget counters, attempts, the per-turn guard and settlement
 * audits. Same key schema as the chat table, but a separate retained table, so recreating the chat
 * table cannot reset the monthly consumption. Refuses to point at the chat table.
 */
export function ledgerStore(client: DynamoDBClient, ledgerTable: string, now?: () => Date, chatTable?: string) {
  if (!ledgerTable || ledgerTable === chatTable) throw new Error('The ledger must be a table separate from the chat table')
  return new ChatStore(client, ledgerTable, now)
}

/**
 * The only way a runtime builds its model budget: on the ledger table named by the environment. Fails closed
 * (ConfigError) when the variable is missing, invalid or equal to the chat table.
 */
export function modelBudgetFromEnv(client: DynamoDBClient, env: Readonly<Record<string, string | undefined>>,
  caps: Readonly<Record<string, number>>, now?: () => Date) {
  const { ledgerTableName } = loadLedgerRuntime(env)
  return new ModelBudget(ledgerStore(client, ledgerTableName, now, env.ARTURIA_TABLE_NAME), caps)
}
