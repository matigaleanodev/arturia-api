// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { isActorCurrent, type Actor, type IdentityStore } from './actor.js'

const resourceForAction = {
  'conversation:list': null,
  'conversation:create': null,
  'conversation:read': 'conversation',
  'turn:create': 'conversation',
  'turn:read': 'turn',
  'turn:run': 'turn',
  'turn:stream': 'turn',
  'turn:cancel': 'turn',
} as const

export type Action = keyof typeof resourceForAction
type ResourceKind = Exclude<(typeof resourceForAction)[Action], null>
export interface Permit { readonly allowed: true }
export interface Deny {
  readonly allowed: false
  readonly reason: 'identity' | 'scope' | 'resource'
}

export interface PolicyStore {
  // Reads must use current state and the exact user/scope partition.
  getScopeActions(userId: string, scopeId: string): Promise<readonly Action[] | undefined>
  hasResource(userId: string, scopeId: string, kind: ResourceKind, resourceId: string): Promise<boolean>
}

export function createPolicy(
  identity: Pick<IdentityStore, 'getAccount' | 'getSession'>,
  scopes: PolicyStore,
) {
  return {
    async authorize(actor: Actor, scopeId: string, action: Action, resourceId?: string): Promise<Permit | Deny> {
      const actions = await scopes.getScopeActions(actor.userId, scopeId)
      if (!Object.hasOwn(resourceForAction, action) || !actions?.includes(action)) {
        return { allowed: false, reason: 'scope' }
      }
      const kind = resourceForAction[action]
      if (kind && (!resourceId || !await scopes.hasResource(actor.userId, scopeId, kind, resourceId))) {
        return { allowed: false, reason: 'resource' }
      }
      if (!await isActorCurrent(identity, actor)) return { allowed: false, reason: 'identity' }
      return { allowed: true }
    },
  }
}
