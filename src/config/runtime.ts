// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

type Environment = Readonly<Record<string, string | undefined>>

/** Invalid deployment configuration. The message names variables only, never their values. */
export class ConfigError extends Error {
  constructor(readonly variables: readonly string[]) {
    super('Invalid runtime configuration: ' + variables.join(', '))
    this.name = 'ConfigError'
  }
}

export const PROVIDER_MODES = ['fixture', 'fail'] as const
export type ProviderMode = typeof PROVIDER_MODES[number]
export interface HttpRuntime { readonly tableName: string; readonly clientId: string }
export interface WorkerRuntime { readonly tableName: string; readonly environment: string; readonly providerMode: ProviderMode }

const tableName = /^[A-Za-z0-9_.-]{3,255}$/
const clientId = /^[A-Za-z0-9]{1,128}$/
const environment = /^[a-z][a-z0-9-]{0,31}$/

function reader(env: Environment) {
  const invalid: string[] = []
  const read = (name: string, valid: (value: string) => boolean) => {
    const value = env[name]
    if (typeof value === 'string' && valid(value)) return value
    invalid.push(name)
    return ''
  }
  const done = () => { if (invalid.length) throw new ConfigError(invalid) }
  return { read, done }
}

export function loadHttpRuntime(env: Environment): HttpRuntime {
  const { read, done } = reader(env)
  const runtime = { tableName: read('ARTURIA_TABLE_NAME', v => tableName.test(v)), clientId: read('ARTURIA_CLIENT_ID', v => clientId.test(v)) }
  done()
  return runtime
}

export function loadWorkerRuntime(env: Environment): WorkerRuntime {
  const { read, done } = reader(env)
  const runtime = {
    tableName: read('ARTURIA_TABLE_NAME', v => tableName.test(v)),
    environment: read('ARTURIA_ENVIRONMENT', v => environment.test(v)),
    providerMode: read('ARTURIA_PROVIDER_MODE', v => (PROVIDER_MODES as readonly string[]).includes(v)) as ProviderMode,
  }
  done()
  return runtime
}

/** Evaluates once per execution environment and keeps either the value or the failure. */
export function memoize<T>(load: () => T): () => T {
  let state: { ok: true; value: T } | { ok: false; error: unknown } | undefined
  return () => {
    if (!state) {
      try { state = { ok: true, value: load() } } catch (error) { state = { ok: false, error } }
    }
    if (!state.ok) throw state.error
    return state.value
  }
}
