// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { cancelTurn } from './cancel.js'
import type { Actor } from '../identity/actor.js'
import { createPolicy, type Action } from '../identity/policy.js'
import { ChatStore, scopePartition } from './turns.store.js'
import { ChatError, forbidden, notFound, type ConversationInput, type TurnInput, type TurnSnapshot } from './turns.types.js'

// Leave room for key and attribute overhead below DynamoDB's 400 KiB item limit.
const maxTextBytes = 384 * 1024
const maxRouteIdBytes = 256
function checkBytes(value: string, maximum: number) {
  if (Buffer.byteLength(value, 'utf8') > maximum) {
    throw new ChatError(400, 'INVALID_REQUEST', 'El valor supera el tamaño permitido.')
  }
}

export function createChat(store: ChatStore) {
  const policy = createPolicy(store, store)
  async function authorize(actor: Actor, scopeId: string, action: Action, id?: string) {
    checkBytes(scopeId, maxRouteIdBytes)
    if (id !== undefined) checkBytes(id, maxRouteIdBytes)
    const pk = scopePartition(actor.userId, scopeId)
    checkBytes('OUTBOX#' + pk, 2048)
    const permit = await policy.authorize(actor, scopeId, action, id)
    if (!permit.allowed) throw permit.reason === 'resource' ? notFound() : forbidden()
    return pk
  }
  return {
    async createConversation(actor: Actor, scopeId: string, input: ConversationInput) {
      if (input.title !== undefined) checkBytes(input.title, maxTextBytes)
      await authorize(actor, scopeId, 'conversation:create')
      return store.createConversation(actor, scopeId, input)
    },
    async listConversations(actor: Actor, scopeId: string) {
      return store.listConversations(await authorize(actor, scopeId, 'conversation:list'))
    },
    async getConversation(actor: Actor, scopeId: string, id: string) {
      return store.getConversation(await authorize(actor, scopeId, 'conversation:read', id), id)
    },
    async getTurn(actor: Actor, scopeId: string, id: string) {
      return store.getTurn(await authorize(actor, scopeId, 'turn:read', id), id)
    },
    async cancelTurn(actor: Actor, scopeId: string, id: string) {
      await authorize(actor, scopeId, 'turn:cancel', id)
      await authorize(actor, scopeId, 'turn:read', id)
      await cancelTurn(store, actor, { userId: actor.userId, scopeId, turnId: id })
      return store.getTurn(await authorize(actor, scopeId, 'turn:read', id), id)
    },
    async acceptTurn(actor: Actor, scopeId: string, id: string, key: string, input: TurnInput): Promise<TurnSnapshot> {
      checkBytes(input.text, maxTextBytes)
      await authorize(actor, scopeId, 'turn:create', id)
      return store.acceptTurn(actor, scopeId, id, key, input)
    },
  }
}
export type Chat = ReturnType<typeof createChat>
