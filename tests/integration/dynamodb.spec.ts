// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { expect, test, vi } from 'vitest'
import { integrationDatabase } from '../support/dynamodb.js'
import { fixtureA, fixtureB, fixtureTime } from '../support/fixtures.js'

const sk = { S: 'fixture-record' }
const partition = ({ userId, scopeId }: { userId: string; scopeId: string }) => ({
  S: userId + '#' + scopeId,
})

test('local_dynamodb_conditional_write', async () => {
  const { client, tableName } = integrationDatabase()
  const write = (pk: { S: string }, value: string) => new PutItemCommand({
    TableName: tableName,
    Item: { pk, sk, value: { S: value }, createdAt: { S: new Date().toISOString() } },
    ConditionExpression: 'attribute_not_exists(pk)',
  })
  const read = (pk: { S: string }) => client.send(new GetItemCommand({
    TableName: tableName,
    Key: { pk, sk },
    ConsistentRead: true,
  }))

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(fixtureTime))
  try {
    await client.send(write(partition(fixtureA), 'initial'))
    await expect(client.send(write(partition(fixtureA), 'replacement')))
      .rejects.toMatchObject({ name: 'ConditionalCheckFailedException' })
    await client.send(write(partition(fixtureB), 'independent'))
    expect((await read(partition(fixtureA))).Item).toMatchObject({
      value: { S: 'initial' },
      createdAt: { S: fixtureTime },
    })
    expect((await read(partition(fixtureB))).Item?.value).toEqual({ S: 'independent' })
  } finally {
    vi.useRealTimers()
    client.destroy()
  }
})
