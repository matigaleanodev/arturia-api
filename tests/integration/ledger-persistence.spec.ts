// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// The monthly AI consumption lives in its own table: dropping and recreating the chat table (a pilot
// teardown) must not reset it, while a budget kept in the chat table would be reset.

import { randomUUID } from 'node:crypto'
import { CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ChatStore } from '../../src/chat/turns.store.js'
import { ModelBudget, type Tariff } from '../../src/models/budget.js'
import { ConfigError } from '../../src/config/runtime.js'
import { ledgerStore, modelBudgetFromEnv } from '../../src/models/ledger-store.js'
import { integrationDatabase } from '../support/dynamodb.js'

const usd = 1_000_000
const provider = 'fixture-a'
const price: Tariff = { inputPerMillion: 1, outputPerMillion: 1, toolCall: 1, verifiedAt: Date.UTC(2025, 0), expiresAt: Date.UTC(2040, 0) }
const time = Date.UTC(2038, 3, 10)
const tables: string[] = []
let local: ReturnType<typeof integrationDatabase>

const createTable = async (prefix: string) => {
  const TableName = `${prefix}-${randomUUID()}`
  await local.client.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }))
  tables.push(TableName)
  return TableName
}
const drop = (TableName: string) => local.client.send(new DeleteTableCommand({ TableName }))
const reserve = (budget: ModelBudget, amount: number) =>
  budget.reserveAttempt(randomUUID(), 'user-1', 'scope-1', provider, amount, { model: 'm', operation: 'chat', tariff: price })

beforeEach(() => { local = integrationDatabase() })
afterEach(async () => {
  await Promise.all(tables.splice(0).map(t => drop(t).catch(() => undefined)))
  local.client.destroy()
})

test('recreating_the_chat_table_keeps_the_month_consumption_blocking', async () => {
  const ledger = await createTable('ledger')
  let chat = await createTable('chat')
  const budgetOf = () => new ModelBudget(ledgerStore(local.client, ledger, () => new Date(time)), { [provider]: 6 * usd })
  expect((await reserve(budgetOf(), 6 * usd)).allowed).toBe(true)

  await drop(chat)
  chat = await createTable('chat')
  // A new execution environment after the recreation sees the same consumption.
  expect((await reserve(budgetOf(), 1)).allowed).toBe(false)
})

test('control_a_budget_kept_in_the_chat_table_is_reset_by_recreating_it', async () => {
  let chat = await createTable('chat')
  const budgetOf = () => new ModelBudget(new ChatStore(local.client, chat, () => new Date(time)), { [provider]: 6 * usd })
  expect((await reserve(budgetOf(), 6 * usd)).allowed).toBe(true)
  await drop(chat)
  chat = await createTable('chat')
  expect((await reserve(budgetOf(), 6 * usd)).allowed).toBe(true)
})

test('ledger_store_rejects_the_chat_table_name', async () => {
  const chat = await createTable('chat')
  expect(() => ledgerStore(local.client, chat, () => new Date(time), chat)).toThrow()
})

test('the budget of a runtime is built only on the ledger table and fails closed without it', async () => {
  const ledger = await createTable('ledger')
  const chat = await createTable('chat')
  const env = { ARTURIA_TABLE_NAME: chat, ARTURIA_LEDGER_TABLE_NAME: ledger }
  const budget = modelBudgetFromEnv(local.client, env, { [provider]: 6 * usd }, () => new Date(time))
  expect((await reserve(budget, usd)).allowed).toBe(true)
  const inLedger = await new ChatStore(local.client, ledger).read('MODEL-BUDGET#' + new Date(time).toISOString().slice(0, 7), 'TOTAL')
  const inChat = await new ChatStore(local.client, chat).read('MODEL-BUDGET#' + new Date(time).toISOString().slice(0, 7), 'TOTAL')
  expect(inLedger?.allocated).toBe(usd)
  expect(inChat).toBeUndefined()
  expect(() => modelBudgetFromEnv(local.client, { ARTURIA_TABLE_NAME: chat }, {})).toThrow(ConfigError)
  expect(() => modelBudgetFromEnv(local.client, { ...env, ARTURIA_LEDGER_TABLE_NAME: chat }, {})).toThrow(ConfigError)
})
