// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { GetParameterCommand, type GetParameterCommandOutput } from '@aws-sdk/client-ssm'
import {
  ENABLED_PROVIDERS, PROVIDER_PARAMETER_PREFIX, PROVIDER_PARAMETER_VARIABLE, isProviderParameterPrefix, providerParameterName,
} from '../config/catalog-config.js'
import { ConfigError } from '../config/runtime.js'

export { PROVIDER_PARAMETER_PREFIX, PROVIDER_PARAMETER_VARIABLE, isProviderParameterPrefix, providerParameterName }
export const CREDENTIAL_PROVIDERS = ['openai', 'anthropic'] as const
export type CredentialProvider = typeof CREDENTIAL_PROVIDERS[number]

/** Longest time a key stays in memory. A rotated key is picked up at the latest after this, or at once after a 401. */
export const DEFAULT_CREDENTIAL_TTL_MS = 5 * 60_000
const MAX_CREDENTIAL_TTL_MS = 15 * 60_000

// Letters, digits, dash, underscore and dot: a key can never smuggle a header separator or a control character, and a JSON
// document or a quoted value pasted by mistake into the parameter is refused instead of being sent as a key.
const keyPattern = /^[A-Za-z0-9._-]{20,512}$/

/** The key could not be obtained. Never carries the secret, the SDK error or the parameter name. */
export class CredentialUnavailable extends Error {
  override name = 'CredentialUnavailable'
  constructor() { super('Provider credential unavailable') }
}

export interface ProviderCredentials {
  /** Key of one provider. Rejects with {@link CredentialUnavailable} and nothing else. */
  get(provider: CredentialProvider, signal?: AbortSignal): Promise<string>
  /** Forget the cached keys, so the next use reads the parameters again (after the provider rejected a key). */
  invalidate(): void
}

interface Options {
  /** Reference to where the keys live. Must be exactly {@link PROVIDER_PARAMETER_PREFIX}. */
  readonly parameterPrefix: string
  /** The only operation the reader uses; an `SSMClient` satisfies it. */
  readonly client: { send(command: GetParameterCommand, options?: { abortSignal?: AbortSignal }): Promise<Pick<GetParameterCommandOutput, 'Parameter'>> }
  readonly now?: () => number
  readonly ttlMs?: number
  /** Providers whose parameter may be read. Defaults to the enabled providers: any other is refused without a request. */
  readonly providers?: readonly CredentialProvider[]
}

/** The key of a SecureString parameter, or nothing sendable: a plain String or StringList is never accepted. */
function parse(output: unknown): string {
  const parameter = (output as { Parameter?: { Type?: unknown; Value?: unknown } } | undefined)?.Parameter
  const key = parameter?.Value
  if (parameter?.Type !== 'SecureString' || typeof key !== 'string' || !keyPattern.test(key)) throw new CredentialUnavailable()
  return key
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
 * Reads each provider key from its own SecureString parameter in Parameter Store, by its exact name and only when that
 * provider is used. The keys live only in this closure: a short TTL cache, never logged, never part of an error. Every
 * failure (missing parameter, wrong type, invalid value, denied access, timeout) is the same constant error.
 */
export function createProviderCredentials({ parameterPrefix, client, now = Date.now, ttlMs = DEFAULT_CREDENTIAL_TTL_MS, providers = ENABLED_PROVIDERS as readonly CredentialProvider[] }: Options): ProviderCredentials {
  if (!isProviderParameterPrefix(parameterPrefix)) throw new ConfigError([PROVIDER_PARAMETER_VARIABLE])
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CREDENTIAL_TTL_MS) throw new RangeError('Invalid credential TTL')
  const cached = new Map<CredentialProvider, { key: string; expiresAt: number }>()
  const loading = new Map<CredentialProvider, Promise<string>>()

  const load = (provider: CredentialProvider, signal?: AbortSignal): Promise<string> => {
    const hit = cached.get(provider)
    if (hit && now() < hit.expiresAt) return Promise.resolve(hit.key)
    let pending = loading.get(provider)
    if (!pending) {
      pending = (async () => {
        try {
          const output = await client.send(new GetParameterCommand({ Name: providerParameterName(provider), WithDecryption: true }), { abortSignal: signal })
          const key = parse(output)
          cached.set(provider, { key, expiresAt: now() + ttlMs })
          return key
        } catch { throw new CredentialUnavailable() } finally { loading.delete(provider) }
      })()
      loading.set(provider, pending)
    }
    return pending
  }

  return {
    async get(provider, signal) {
      if (!providers.includes(provider)) throw new CredentialUnavailable()
      return until(load(provider, signal), signal)
    },
    invalidate() { cached.clear() },
  }
}
