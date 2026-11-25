// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CreateTableCommand, ListTablesCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'

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

export function createLocalDatabase() {
  const runId = randomUUID()
  const projectName = 'arturia-test-' + runId
  const tableName = projectName

  const compose = (...args: string[]) => execFileSync(
    'docker', ['compose', '-f', 'compose.test.yml', '--project-name', projectName, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 },
  ).trim()

  let started = false
  function down() {
    if (!started) return
    compose('down', '--timeout', '3')
    const label = 'label=com.docker.compose.project=' + projectName
    for (const args of [['ps', '-aq'], ['network', 'ls', '-q']]) {
      if (execFileSync('docker', [...args, '--filter', label], { encoding: 'utf8', timeout: 10_000 }).trim()) {
        throw new Error('DynamoDB Local cleanup incomplete for ' + projectName)
      }
    }
    started = false
  }

  async function start() {
    started = true
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
      return { endpoint, tableName }
    } finally {
      client.destroy()
    }
  }

  return { start, down }
}
