// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Manual recovery of turn intents whose outbox row stayed pending because the relay failed. It uses
// the same publish path as the relay: a reference is sent only while its row is pending and the row
// is marked afterwards. A duplicate send is harmless because the worker claims the durable turn by ID.

import type { ChatStore } from '../chat/turns.store.js'
import type { TurnReference } from '../chat/turns.types.js'
import { publishOutbox, type TurnQueue } from '../jobs/outbox.js'
import { PILOT_SCOPE_IDS } from './provision.js'

export async function pendingOutboxFor(store: ChatStore, userId: string, scopeIds: readonly string[] = PILOT_SCOPE_IDS) {
  const refs: TurnReference[] = []
  for (const scopeId of scopeIds) refs.push(...await store.pendingOutbox(userId, scopeId))
  return refs
}

/** Publishes in order and stops at the first failure: the rest stays pending for the next run. */
export async function republishOutbox(store: ChatStore, queue: TurnQueue, refs: readonly TurnReference[]) {
  let published = 0
  let skipped = 0
  for (const ref of refs) {
    if (!await store.outboxPending(ref)) { skipped++; continue }
    await publishOutbox(store, queue, ref)
    published++
  }
  return { published, skipped }
}
