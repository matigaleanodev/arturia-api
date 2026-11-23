// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CreateTableCommand, ListTablesCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { TestProject } from 'vitest/node'
import { localDynamoClient } from './dynamodb.js'

async function waitForDynamoDB(client: DynamoDBClient) {
  const deadline = performance.now() + 30_000
  for (;;) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }), {
        abortSignal: AbortSignal.timeout(1000),
      })
      return
    } catch (error) {
      if (performance.now() >= deadline) {
        throw new Error('DynamoDB Local did not respond within 30 seconds', { cause: error })
      }
      await delay(250)
    }
  }
}

export default async function setup(project: TestProject) {
  const runId = randomUUID()
  const projectName = 'arturia-test-' + runId
  const tableName = projectName

  const compose = (...args: string[]) => execFileSync(
    'docker', ['compose', '-f', 'compose.test.yml', '--project-name', projectName, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 },
  ).trim()
  let needsCleanup = true
  const down = () => {
    if (!needsCleanup) return
    compose('down')
    needsCleanup = false
    process.off('exit', cleanupOnExit)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
  const cleanupOnExit = () => {
    try {
      down()
    } catch (error) {
      console.error('Failed to remove the DynamoDB Local project', projectName, error)
    }
  }
  const onInterrupt = () => process.exit(130)
  const onTerminate = () => process.exit(143)

  process.once('exit', cleanupOnExit)
  process.prependOnceListener('SIGINT', onInterrupt)
  process.prependOnceListener('SIGTERM', onTerminate)

  try {
    compose('up', '-d')
    const endpoint = 'http://' + compose('port', 'dynamodb', '8000')
    const client = localDynamoClient(endpoint)
    try {
      await waitForDynamoDB(client)
      await client.send(new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }), { abortSignal: AbortSignal.timeout(10_000) })
      project.provide('integrationDatabase', { endpoint, tableName })
    } finally {
      client.destroy()
    }
  } catch (setupError) {
    try {
      down()
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], 'DynamoDB Local setup and cleanup failed')
    }
    throw setupError
  }

  return down
}
