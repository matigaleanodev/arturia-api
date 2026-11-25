// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { ENABLED_PROVIDERS } from '../config/catalog-config.js'
import type { CredentialProvider, ProviderCredentials } from '../secrets/provider-secret.js'
import { ModelPolicyDenied } from './provider.js'
import { WireNotSent, type ModelWire } from './wire.js'

/** The only hosts a provider key is ever sent to. Not configurable from the environment. */
export const PROVIDER_ORIGINS: Readonly<Record<CredentialProvider, string>> = Object.freeze({
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
})
/** The only path of each provider: one streaming endpoint per provider. */
const PROVIDER_PATHS: Readonly<Record<CredentialProvider, string>> = Object.freeze({
  openai: '/v1/responses',
  anthropic: '/v1/messages',
})

// The wire owns authentication and routing: nothing the adapter sends can replace them.
const reserved = /^(?:authorization|x-api-key|api-key|host|cookie|proxy-authorization|content-length|connection|transfer-encoding)$/i
const loopback = new Set(['127.0.0.1', '[::1]', 'localhost'])
const requestIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/

export interface ResponseMeta {
  readonly provider: string
  readonly status: number
  /** The provider's own request ID, to match a charge on the invoice. Dropped unless it has the expected shape. */
  readonly requestId?: string
}

export interface FetchWireOptions {
  readonly credentials: Pick<ProviderCredentials, 'get' | 'invalidate'>
  /** Test servers only: loopback origins that replace a provider host. Anything else is refused at construction. */
  readonly origins?: Partial<Record<CredentialProvider, string>>
  readonly fetch?: typeof globalThis.fetch
  /** Providers the transport may reach. Defaults to the enabled providers: any other is refused before a key is read. */
  readonly providers?: readonly CredentialProvider[]
  /** Observes each response without its content: provider, status and request ID. */
  readonly onResponse?: (meta: ResponseMeta) => void
}

function resolveOrigins(overrides: FetchWireOptions['origins']): Record<CredentialProvider, string> {
  const origins = { ...PROVIDER_ORIGINS }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    let url: URL | undefined
    try { url = new URL(value) } catch { /* rejected below */ }
    if (!Object.hasOwn(PROVIDER_PATHS, name) || !url || url.origin !== value || !loopback.has(url.hostname)) {
      throw new ModelPolicyDenied('Invalid model origin')
    }
    origins[name as CredentialProvider] = value
  }
  return origins
}

/**
 * Real transport of the model adapters: one `fetch` POST per attempt to the exact origin and path of the
 * provider, with the key read from the secret, `redirect: 'error'` and no retry of any kind. The timeout and the
 * cancellation belong to the adapter, which hands over the signal. A failure after the request was issued is
 * never retried here, because the provider may already have started billing it.
 */
export function createFetchWire({ credentials, origins: overrides, fetch: send = globalThis.fetch, onResponse, providers = ENABLED_PROVIDERS as readonly CredentialProvider[] }: FetchWireOptions): ModelWire {
  const origins = resolveOrigins(overrides)
  return async ({ provider, path, headers, body, signal }) => {
    if (!providers.includes(provider as CredentialProvider) || !Object.hasOwn(PROVIDER_PATHS, provider) || path !== PROVIDER_PATHS[provider as CredentialProvider] || signal.aborted) throw new WireNotSent()
    const name = provider as CredentialProvider
    let outbound: Headers
    try {
      const key = await credentials.get(name, signal)
      if (signal.aborted) throw new WireNotSent()
      outbound = new Headers()
      for (const [header, value] of Object.entries(headers)) if (!reserved.test(header)) outbound.set(header, value)
      if (name === 'openai') outbound.set('authorization', 'Bearer ' + key)
      else outbound.set('x-api-key', key)
    } catch { throw new WireNotSent() }
    const response = await send(origins[name] + path, { method: 'POST', headers: outbound, body, signal, redirect: 'error' })
    if (response.status === 401) credentials.invalidate()
    if (onResponse) {
      const id = response.headers.get(name === 'openai' ? 'x-request-id' : 'request-id')
      try { onResponse({ provider: name, status: response.status, ...(id && requestIdPattern.test(id) ? { requestId: id } : {}) }) } catch { /* observation only */ }
    }
    return response
  }
}
