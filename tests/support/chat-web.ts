import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { scopePartition, type ChatStore } from '../../src/chat/turns.store.js'
import { fixtureA, fixtureB } from './fixtures.js'

const users = [
  { fixture: fixtureA, scopes: [fixtureA.scopeId, 'integrated-work'], token: 'integrated.a.local' },
  { fixture: fixtureB, scopes: [fixtureB.scopeId], token: 'integrated.b.local' },
]
export const localScopes = users.flatMap(({ fixture, scopes }) => scopes.map(scopeId => ({ userId: fixture.userId, scopeId })))
const sessionId = 'integrated-session'
const actions = new Set(['conversation:list', 'conversation:create', 'conversation:read',
  'turn:create', 'turn:read', 'turn:run', 'turn:cancel', 'turn:stream'])

export async function resolveLocalActor(token: string) {
  const user = users.find(u => u.token === token)
  if (user) return { userId: user.fixture.userId, sessionId }
}

export async function provisionIdentities(store: ChatStore) {
  for (const { fixture: { userId }, scopes } of users) {
    const pk = JSON.stringify([userId])
    for (const item of [
      { pk, sk: 'ACCOUNT', status: 'active', mfaVerifiedAt: 1 },
      { pk, sk: 'SESSION#' + sessionId, status: 'active', authTime: 2 },
      ...scopes.map(scope => ({ pk: scopePartition(userId, scope), sk: 'SCOPE', actions })),
    ]) {
      await store.db.send(new PutCommand({ TableName: store.tableName, Item: item }))
    }
  }
}
