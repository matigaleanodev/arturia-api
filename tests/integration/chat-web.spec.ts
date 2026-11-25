import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChatStore } from '../../src/chat/turns.store.js'
import { createChat } from '../../src/chat/turns.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { provisionIdentities, resolveLocalActor } from '../support/chat-web.js'

const database = integrationDatabase()
const store = new ChatStore(database.client, database.tableName)

beforeAll(() => provisionIdentities(store))
afterAll(() => database.client.destroy())

test('local identities have distinct durable grants and exact synthetic credentials', async () => {
  const owner = await resolveLocalActor('integrated.a.local')
  const other = await resolveLocalActor('integrated.b.local')
  expect(owner).toBeDefined()
  expect(other).toBeDefined()
  expect(await resolveLocalActor('unknown.a.local')).toBeUndefined()
  expect(await store.getScopeActions(owner!.userId, 'fixture-personal')).toContain('turn:run')
  expect(await store.getScopeActions(owner!.userId, 'integrated-work')).toContain('turn:read')
  expect(await store.getScopeActions(other!.userId, 'fixture-work')).toContain('turn:run')
  await expect(createChat(store).listConversations(other!, 'fixture-personal')).rejects.toMatchObject({ status: 403 })
})
