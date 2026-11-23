// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { generateKeyPairSync, sign } from 'node:crypto'
import { SimpleJwksCache } from 'aws-jwt-verify/jwk'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resolveHttpActor } from '../http/auth.js'
import { createCognitoActorResolver, type AccountState, type SessionState } from './actor.js'
import { createPolicy, type Action } from './policy.js'

const now = Date.parse('2026-01-01T00:00:00Z') / 1_000
const userPoolId = 'us-east-1_FixtureOnly'
const clientId = 'fixture-app-client'
const issuer = 'https://cognito-idp.us-east-1.amazonaws.com/' + userPoolId
const sub = 'fixture-cognito-subject'
const userId = 'fixture-user-a'
const sessionId = 'fixture-token-family'
const foreignSub = 'fixture-cognito-subject-b'
const foreignUserId = 'fixture-user-b'
const foreignSessionId = 'fixture-token-family-b'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const key = { ...publicKey.export({ format: 'jwk' }), kty: 'RSA', kid: 'fixture-key', alg: 'RS256', use: 'sig' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(now * 1_000))
})

afterEach(() => vi.useRealTimers())

function signedToken(overrides: Record<string, unknown> = {}, signingKey = privateKey) {
  const encode = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url')
  const header = encode({ alg: 'RS256', kid: key.kid })
  const claims = encode({
    iss: issuer,
    client_id: clientId,
    token_use: 'access',
    scope: 'openid arturia/access',
    sub,
    origin_jti: sessionId,
    auth_time: now - 30,
    iat: now - 20,
    exp: now + 300,
    ...overrides,
  })
  const input = header + '.' + claims
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')
}

function setup() {
  const subjects = new Map([[sub, userId], [foreignSub, foreignUserId]])
  const accounts = new Map<string, AccountState>([
    [userId, { status: 'active', mfaVerifiedAt: now - 60 }],
    [foreignUserId, { status: 'active', mfaVerifiedAt: now - 60 }],
  ])
  const sessions = new Map<string, SessionState>()
  const identity = {
    findUserIdBySubject: async (subject: string) => subjects.get(subject),
    getAccount: async (id: string) => accounts.get(id),
    getSession: async (id: string, session: string) => sessions.get(JSON.stringify([id, session])),
    registerSession: async (id: string, session: string, authTime: number): Promise<SessionState> => {
      const key = JSON.stringify([id, session])
      const state = sessions.get(key) ?? { status: 'active', authTime }
      sessions.set(key, state)
      return state
    },
  }
  const jwksCache = new SimpleJwksCache({ fetcher: {
    fetch: async () => { throw new Error('Tests use offline JWKS only') },
  } })
  jwksCache.addJwks(issuer + '/.well-known/jwks.json', { keys: [key] })
  const { resolveActor } = createCognitoActorResolver({ userPoolId, clientId }, identity, jwksCache)
  const actions: readonly Action[] = ['conversation:list', 'conversation:read', 'turn:create', 'turn:read', 'turn:stream']
  const scopes = [
    { owner: userId, id: 'fixture-personal', conversation: 'fixture-conversation-a', turn: 'fixture-turn-a' },
    { owner: userId, id: 'fixture-work' },
    { owner: foreignUserId, id: 'fixture-personal', conversation: 'fixture-conversation-b', turn: 'fixture-turn-b' },
    { owner: foreignUserId, id: 'fixture-foreign', conversation: 'fixture-conversation-b-work', turn: 'fixture-turn-b-work' },
  ]
  const findScope = (owner: string, id: string) => scopes.find((scope) => scope.owner === owner && scope.id === id)
  const { authorize } = createPolicy(identity, {
    getScopeActions: async (id, scopeId) => findScope(id, scopeId) ? actions : undefined,
    hasResource: async (id, scopeId, kind, resourceId) => findScope(id, scopeId)?.[kind] === resourceId,
  })
  return { accounts, sessions, resolveActor, authorize }
}

test('denies_cross_user_scope', async () => {
  const { resolveActor, authorize } = setup()
  const actor = await resolveActor(signedToken({ scopeId: 'fixture-foreign' }))
  const foreignActor = await resolveActor(signedToken({ sub: foreignSub, origin_jti: foreignSessionId }))
  expect(actor).toEqual({ userId, sessionId })
  expect(foreignActor).toEqual({ userId: foreignUserId, sessionId: foreignSessionId })
  if (!actor || !foreignActor) throw new Error('Expected two verified actors')

  const sharedScopeId = 'fixture-personal'
  const records = [
    { owner: actor, other: foreignActor, conversation: 'fixture-conversation-a', turn: 'fixture-turn-a' },
    { owner: foreignActor, other: actor, conversation: 'fixture-conversation-b', turn: 'fixture-turn-b' },
  ]
  for (const { owner, other, conversation, turn } of records) {
    expect(await authorize(owner, sharedScopeId, 'conversation:list')).toEqual({ allowed: true })
    expect(await authorize(owner, sharedScopeId, 'conversation:read', conversation)).toEqual({ allowed: true })
    expect(await authorize(owner, sharedScopeId, 'turn:create', conversation)).toEqual({ allowed: true })
    expect(await authorize(owner, sharedScopeId, 'turn:read', turn)).toEqual({ allowed: true })
    expect(await authorize(other, sharedScopeId, 'conversation:read', conversation)).toEqual({ allowed: false, reason: 'resource' })
    expect(await authorize(other, sharedScopeId, 'turn:create', conversation)).toEqual({ allowed: false, reason: 'resource' })
    expect(await authorize(other, sharedScopeId, 'turn:read', turn)).toEqual({ allowed: false, reason: 'resource' })
  }

  const foreignScopeId = 'fixture-foreign'
  const foreignConversation = 'fixture-conversation-b-work'
  expect(await authorize(foreignActor, foreignScopeId, 'conversation:read', foreignConversation)).toEqual({ allowed: true })
  expect(await authorize(foreignActor, foreignScopeId, 'turn:create', foreignConversation)).toEqual({ allowed: true })
  expect(await authorize(actor, foreignScopeId, 'conversation:list')).toEqual({ allowed: false, reason: 'scope' })
  expect(await authorize(actor, foreignScopeId, 'conversation:read', foreignConversation)).toEqual({ allowed: false, reason: 'scope' })
  expect(await authorize(actor, foreignScopeId, 'turn:create', foreignConversation)).toEqual({ allowed: false, reason: 'scope' })

  expect(await authorize(actor, 'fixture-work', 'conversation:list')).toEqual({ allowed: true })
  expect(await authorize(actor, 'fixture-work', 'turn:create', 'fixture-conversation-a')).toMatchObject({ allowed: false })
  expect(await authorize(actor, sharedScopeId, 'turn:read', 'fixture-conversation-a')).toMatchObject({ allowed: false })
  expect(await authorize(actor, sharedScopeId, 'turn:read')).toMatchObject({ allowed: false })
  expect(await authorize(actor, sharedScopeId, 'turn:cancel', 'fixture-turn-a')).toMatchObject({ allowed: false })
})

test('revoked_session_denied_with_signed_jwt', async () => {
  const { accounts, sessions, resolveActor, authorize } = setup()
  const jwt = signedToken()
  const actor = await resolveActor(jwt)
  expect(actor).toEqual({ userId, sessionId })
  if (!actor) throw new Error('Expected a verified actor')
  const replay = () => authorize(actor, 'fixture-personal', 'turn:stream', 'fixture-turn-a')
  expect(await replay()).toEqual({ allowed: true })
  expect(await authorize({ userId, sessionId: 'unregistered-session' }, 'fixture-personal', 'conversation:list'))
    .toEqual({ allowed: false, reason: 'identity' })
  const sessionKey = JSON.stringify([userId, sessionId])
  sessions.set(sessionKey, { status: 'revoked' })
  expect(await resolveActor(jwt)).toBeUndefined()
  expect(await resolveActor(signedToken({ jti: 'fresh-jwt-same-session' }))).toBeUndefined()
  expect(await replay()).toMatchObject({ allowed: false })
  expect(await resolveActor(signedToken({ origin_jti: 'different-session' }))).toEqual({
    userId, sessionId: 'different-session',
  })
  accounts.set(userId, { status: 'disabled' })
  expect(await resolveActor(signedToken({ origin_jti: 'different-session' }))).toBeUndefined()
  expect(await authorize({ userId, sessionId: 'different-session' }, 'fixture-personal', 'conversation:list')).toMatchObject({ allowed: false })
})

test('onboarding_token_denied_before_and_after_verified_mfa', async () => {
  const { accounts, sessions, resolveActor } = setup()
  accounts.set(userId, { status: 'active' })
  const onboardingToken = signedToken({ auth_time: now - 100 })
  expect(await resolveActor(onboardingToken)).toBeUndefined()
  accounts.set(userId, { status: 'active', mfaVerifiedAt: now - 60 })
  expect(await resolveActor(onboardingToken)).toBeUndefined()
  expect(await resolveActor(signedToken({ auth_time: now - 60 }))).toBeUndefined()
  expect(await resolveActor(signedToken({ scope: 'aws.cognito.signin.user.admin' }))).toBeUndefined()
  expect(sessions.size).toBe(0)
  expect(await resolveActor(signedToken())).toEqual({ userId, sessionId })
})

test('invalid_bearer_cannot_establish_a_session', async () => {
  const { sessions, resolveActor } = setup()
  const tokens = [
    signedToken({ iss: issuer + '-foreign' }),
    signedToken({ client_id: 'foreign-app' }),
    signedToken({ token_use: 'id', aud: clientId }),
    signedToken({ exp: now - 1 }),
    signedToken({ exp: undefined }),
    signedToken({ origin_jti: undefined }),
    signedToken({ scope: 'openid arturia/access-extra' }),
    signedToken({ sub: 'unregistered-subject' }),
    signedToken({ auth_time: undefined }),
    signedToken({}, otherKey),
  ]
  for (const token of tokens) expect(await resolveActor(token)).toBeUndefined()
  expect(sessions.size).toBe(0)
})

test('access_token_is_rejected_at_exact_expiration', async () => {
  const { resolveActor } = setup()
  const expiresAt = (now + 300) * 1_000
  const jwt = signedToken({ exp: expiresAt / 1_000 })
  vi.setSystemTime(new Date(expiresAt - 1))
  expect(await resolveActor(jwt)).toEqual({ userId, sessionId })
  vi.setSystemTime(new Date(expiresAt))
  expect(await resolveActor(jwt)).toBeUndefined()
})

test('http_auth_accepts_only_a_single_bearer_token', async () => {
  const { resolveActor } = setup()
  const jwt = signedToken()
  for (const header of [undefined, jwt, 'Basic ' + jwt, 'Bearer ' + jwt + ', Bearer ' + jwt]) {
    expect(await resolveHttpActor(resolveActor, header)).toBeUndefined()
  }
  expect(await resolveHttpActor(resolveActor, 'bearer ' + jwt)).toEqual({ userId, sessionId })
})
