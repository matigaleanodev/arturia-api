// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { TransactGetCommand } from '@aws-sdk/lib-dynamodb'
import { scopePartition, turnKey, type ChatStore } from '../chat/turns.store.js'
import { isActorCurrent } from '../identity/actor.js'
import { ModelPolicyDenied, type ProviderRequest } from './provider.js'
import { directUserMessage, type ModelContext } from './egress.js'

// One serializable snapshot binds source, grants, identity, and the live queue lease.
// The caller's copy of the text is deliberately not used.
export async function currentTurnContext(store: ChatStore, request: ProviderRequest, provider: string): Promise<ModelContext> {
  const { ref, leaseId, sessionId, messageSk, attemptId } = request
  const pk = scopePartition(ref.userId, ref.scopeId)
  const user = JSON.stringify([ref.userId])
  const keys = [
    { pk: user, sk: 'ACCOUNT' }, { pk: user, sk: 'SESSION#' + sessionId },
    { pk, sk: 'SCOPE' }, turnKey(ref), { pk, sk: messageSk }, { pk, sk: 'MODEL#' + provider }, { pk, sk: 'MODEL-SOURCES' },
  ]
  const { Responses } = await store.transactRead(new TransactGetCommand({
    TransactItems: keys.map(Key => ({ Get: { TableName: store.tableName, Key } })),
  }), request.signal)
  const [account, session, scope, turn, message, grant, access] = (Responses ?? []).map(r => r.Item)
  const identity = await isActorCurrent({
    getAccount: async () => account?.status === 'active' ? { status: 'active', mfaVerifiedAt: account.mfaVerifiedAt } : undefined,
    getSession: async () => session?.status === 'active' ? { status: 'active', authTime: session.authTime } : undefined,
  }, { userId: ref.userId, sessionId })
  if (!identity || !(scope?.actions instanceof Set) || !scope.actions.has('turn:run') || !turn ||
      turn.status !== 'running' || turn.leaseId !== leaseId || turn.attemptId !== attemptId ||
      !Number.isSafeInteger(turn.leaseUntil) || turn.leaseUntil <= store.now().getTime() ||
      turn.sessionId !== sessionId || turn.messageSk !== messageSk || turn.sendState !== 'uncertain' ||
      !message || message.turnId !== ref.turnId || !grant) throw new ModelPolicyDenied('Model authority denied')
  // The exact T05 message row is user-authored. Other producers must supply provenance explicitly.
  const sources = Object.hasOwn(message, 'modelSources') ? message.modelSources : [directUserMessage]
  return { message: { text: message.text, modelSources: sources }, grant, access }
}
