// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { JwksCache } from 'aws-jwt-verify/jwk'

export const ARTURIA_ACCESS_SCOPE = 'arturia/access'

export interface Actor {
  readonly userId: string
  readonly sessionId: string
}

export type AccountState =
  // UTC seconds recorded by trusted administration after verifying TOTP enrollment.
  | { readonly status: 'active'; readonly mfaVerifiedAt?: number }
  | { readonly status: 'disabled' }

export type SessionState =
  | { readonly status: 'active'; readonly authTime: number }
  | { readonly status: 'revoked' }

export interface IdentityStore {
  // All reads require current state (strong consistency for DynamoDB).
  findUserIdBySubject(subject: string): Promise<string | undefined>
  getAccount(userId: string): Promise<AccountState | undefined>
  getSession(userId: string, sessionId: string): Promise<SessionState | undefined>
  // Insert atomically if absent and return current state, preserving any revocation.
  registerSession(userId: string, sessionId: string, authTime: number): Promise<SessionState>
}

export type ResolveActor = (token: string) => Promise<Actor | undefined>

interface CognitoIdentityConfig {
  readonly userPoolId: string
  readonly clientId: string
}

export function permitsAuthentication(account: AccountState | undefined, authTime: number): boolean {
  if (account?.status !== 'active' || account.mfaVerifiedAt === undefined) return false
  return Number.isSafeInteger(account.mfaVerifiedAt) && account.mfaVerifiedAt >= 0 &&
    Number.isSafeInteger(authTime) && authTime > account.mfaVerifiedAt
}

export async function isActorCurrent(
  store: Pick<IdentityStore, 'getAccount' | 'getSession'>,
  actor: Actor,
): Promise<boolean> {
  const account = await store.getAccount(actor.userId)
  const session = await store.getSession(actor.userId, actor.sessionId)
  return session?.status === 'active' && permitsAuthentication(account, session.authTime)
}

export function createCognitoActorResolver(
  config: CognitoIdentityConfig,
  store: IdentityStore,
  jwksCache?: JwksCache,
): { readonly resolveActor: ResolveActor } {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    tokenUse: 'access',
    scope: ARTURIA_ACCESS_SCOPE,
  }, jwksCache ? { jwksCache } : undefined)

  return {
    async resolveActor(token) {
      const claims = await verifier.verify(token).catch(() => undefined)
      if (!claims) return
      const { sub, origin_jti: sessionId, auth_time: authTime, exp } = claims
      if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= Date.now() / 1_000) return
      if (typeof sub !== 'string' || !sub.trim() ||
          typeof sessionId !== 'string' || !sessionId.trim() ||
          typeof authTime !== 'number') return

      const userId = await store.findUserIdBySubject(sub)
      if (!userId) return
      const account = await store.getAccount(userId)
      // A token issued during setup stays ineligible after admin activation.
      if (!permitsAuthentication(account, authTime)) return

      const session = await store.getSession(userId, sessionId) ??
        await store.registerSession(userId, sessionId, authTime)
      if (session.status !== 'active' || !permitsAuthentication(account, session.authTime)) return
      return { userId, sessionId }
    },
  }
}
