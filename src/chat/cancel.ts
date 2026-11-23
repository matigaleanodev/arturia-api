// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { Actor } from '../identity/actor.js'
import { changeTurn } from './generation.store.js'
import type { ChatStore } from './turns.store.js'
import type { TurnReference } from './turns.types.js'

export async function cancelTurn(store: ChatStore, actor: Actor, ref: TurnReference) {
  await changeTurn(store, ref, {
    UpdateExpression: 'SET #status = :cancelled',
    ConditionExpression: '#status IN (:queued, :running)',
    ExpressionAttributeValues: { ':queued': 'queued', ':running': 'running', ':cancelled': 'cancelled' },
  }, { actor, action: 'turn:cancel' })
}
