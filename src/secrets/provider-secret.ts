// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { GetSecretValueCommand, type GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager'
import { PROVIDER_SECRET_NAME, PROVIDER_SECRET_VARIABLE, isProviderSecretArn } from '../config/catalog-config.js'
import { ConfigError } from '../config/runtime.js'

export { PROVIDER_SECRET_NAME, PROVIDER_SECRET_VARIABLE, isProviderSecretArn }
export const CREDENTIAL_PROVIDERS = ['openai', 'anthropic'] as const
export type CredentialProvider = typeof CREDENTIAL_PROVIDERS[number]

/** Longest time a key stays in memory. A rotated key is picked up at the latest after this, or at once after a 401. */
export const DEFAULT_CREDENTIAL_TTL_MS = 5 * 60_000
const MAX_CREDENTIAL_TTL_MS = 15 * 60_000

// Printable ASCII without spaces: a key can never smuggle a header separator or a control character.
const keyPattern = /^[\x21-\x7e]{20,512}$/

/** The key could not be obtained. Never carries the secret, the SDK error or the ARN. */
export class CredentialUnavailable extends Error {
  override name = 'CredentialUnavailable'
  constructor() { super('Provider credential unavailable') }
}

export interface ProviderCredentials {
  /** Key of one provider. Rejects with {@link CredentialUnavailable} and nothing else. */
  get(provider: CredentialProvider, signal?: AbortSignal): Promise<string>
  /** Forget the cached keys, so the next use reads the secret again (after the provider rejected a key). */
  invalidate(): void
}

interface Options {
  readonly secretArn: string
  /** The only operation the reader uses; a `SecretsManagerClient` satisfies it. */
  readonly client: { send(command: GetSecretValueCommand, options?: { abortSignal?: AbortSignal }): Promise<Pick<GetSecretValueCommandOutput, 'SecretString'>> }
  readonly now?: () => number
  readonly ttlMs?: number
}

type Keys = Partial<Record<CredentialProvider, string>>

function parse(secret: unknown): Keys {
  const text = (secret as { SecretString?: unknown } | undefined)?.SecretString
  if (typeof text !== 'string') throw new CredentialUnavailable()
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new CredentialUnavailable() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CredentialUnavailable()
  const entries = Object.entries(value)
  if (!entries.length) throw new CredentialUnavailable()
  const keys: Keys = {}
  for (const [name, key] of entries) {
    if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(name) || typeof key !== 'string' || !keyPattern.test(key)) {
      throw new CredentialUnavailable()
    }
    keys[name as CredentialProvider] = key
  }
  return keys
}

function until<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new CredentialUnavailable())
    if (signal.aborted) return aborted()
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/**
 * Reads the provider keys from a single Secrets Manager secret, by its exact ARN. The keys live only in this
 * closure: a short TTL cache, never logged, never part of an error. Every failure is the same constant error.
 */
export function createProviderCredentials({ secretArn, client, now = Date.now, ttlMs = DEFAULT_CREDENTIAL_TTL_MS }: Options): ProviderCredentials {
  if (!isProviderSecretArn(secretArn)) throw new ConfigError([PROVIDER_SECRET_VARIABLE])
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CREDENTIAL_TTL_MS) throw new RangeError('Invalid credential TTL')
  let cached: { keys: Keys; expiresAt: number } | undefined
  let loading: Promise<Keys> | undefined

  const load = (signal?: AbortSignal): Promise<Keys> => {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.keys)
    loading ??= (async () => {
      try {
        const keys = parse(await client.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: signal }))
        cached = { keys, expiresAt: now() + ttlMs }
        return keys
      } catch { throw new CredentialUnavailable() } finally { loading = undefined }
    })()
    return loading
  }

  return {
    async get(provider, signal) {
      if (!(CREDENTIAL_PROVIDERS as readonly string[]).includes(provider)) throw new CredentialUnavailable()
      const key = (await until(load(signal), signal))[provider]
      if (!key) throw new CredentialUnavailable()
      return key
    },
    invalidate() { cached = undefined },
  }
}
