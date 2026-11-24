// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { pilotFixture, FIXTURE_BLOCKS, FIXTURE_INTERVAL_MS } from '../models/fixture-provider.js'
import { ConfigError, loadHttpRuntime, loadWorkerRuntime, memoize } from './runtime.js'

const http = { ARTURIA_TABLE_NAME: 'arturia-pilot-table', ARTURIA_CLIENT_ID: 'fixtureclient0123456789abcd' }
const worker = { ARTURIA_TABLE_NAME: 'arturia-pilot-table', ARTURIA_ENVIRONMENT: 'pilot', ARTURIA_PROVIDER_MODE: 'fixture' }
const failure = (load: () => unknown) => {
  try { load() } catch (error) { return error }
  throw new Error('Expected a configuration failure')
}

test('config_missing_or_invalid_fails_closed', () => {
  expect(loadHttpRuntime(http)).toEqual({ tableName: http.ARTURIA_TABLE_NAME, clientId: http.ARTURIA_CLIENT_ID })
  expect(loadWorkerRuntime(worker)).toEqual({ tableName: worker.ARTURIA_TABLE_NAME, environment: 'pilot', providerMode: 'fixture' })
  const cases: [() => unknown, string[]][] = [
    [() => loadHttpRuntime({}), ['ARTURIA_TABLE_NAME', 'ARTURIA_CLIENT_ID']],
    [() => loadHttpRuntime({ ...http, ARTURIA_TABLE_NAME: ' ' }), ['ARTURIA_TABLE_NAME']],
    [() => loadHttpRuntime({ ...http, ARTURIA_TABLE_NAME: 'tabla con espacios' }), ['ARTURIA_TABLE_NAME']],
    [() => loadHttpRuntime({ ...http, ARTURIA_CLIENT_ID: 'Bearer secret-value!' }), ['ARTURIA_CLIENT_ID']],
    [() => loadWorkerRuntime({}), ['ARTURIA_TABLE_NAME', 'ARTURIA_ENVIRONMENT', 'ARTURIA_PROVIDER_MODE']],
    [() => loadWorkerRuntime({ ...worker, ARTURIA_PROVIDER_MODE: 'catalog' }), ['ARTURIA_PROVIDER_MODE']],
    [() => loadWorkerRuntime({ ...worker, ARTURIA_PROVIDER_MODE: 'FIXTURE' }), ['ARTURIA_PROVIDER_MODE']],
    [() => loadWorkerRuntime({ ...worker, ARTURIA_ENVIRONMENT: 'Pilot!' }), ['ARTURIA_ENVIRONMENT']],
  ]
  for (const [load, variables] of cases) {
    const error = failure(load)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variables).toEqual(variables)
    // Messages name variables only, never the rejected values.
    for (const value of ['tabla con espacios', 'Bearer secret-value!', 'catalog', 'Pilot!']) {
      expect((error as Error).message).not.toContain(value)
    }
  }
})

test('runtime_configuration_is_read_once', () => {
  let reads = 0
  const valid = memoize(() => { reads++; return loadWorkerRuntime(worker) })
  expect(valid()).toBe(valid())
  const invalid = memoize(() => { reads++; return loadWorkerRuntime({}) })
  expect(invalid).toThrow(ConfigError)
  expect(invalid).toThrow(ConfigError)
  expect(reads).toBe(2)
})

test('fixture_provider_rejected_outside_pilot', async () => {
  for (const environment of ['dev', 'prod', 'production', 'pilotx']) {
    const error = failure(() => pilotFixture({ environment, providerMode: 'fixture' }))
    expect((error as ConfigError).variables).toEqual(['ARTURIA_ENVIRONMENT'])
  }
  const fixture = pilotFixture({ environment: 'pilot', providerMode: 'fixture' }, 5)
  if (fixture.kind !== 'stream') throw new Error('Expected the streaming fixture')
  const seen: number[] = []
  const chunks: string[] = []
  const request = { signal: new AbortController().signal } as Parameters<typeof fixture.provider.stream>[0]
  for await (const event of fixture.provider.stream(request)) { chunks.push(event.text); seen.push(performance.now()) }
  expect(chunks).toEqual(FIXTURE_BLOCKS)
  expect(FIXTURE_BLOCKS).toHaveLength(3)
  expect(FIXTURE_INTERVAL_MS).toBe(1_000)
  for (let i = 1; i < seen.length; i++) expect(seen[i] - seen[i - 1]).toBeGreaterThanOrEqual(4)
})

test('fixture_fail_mode_only_in_pilot', () => {
  expect(pilotFixture({ environment: 'pilot', providerMode: 'fail' })).toEqual({ kind: 'fail' })
  for (const environment of ['dev', 'prod']) {
    const error = failure(() => pilotFixture({ environment, providerMode: 'fail' }))
    expect((error as ConfigError).variables).toEqual(['ARTURIA_ENVIRONMENT'])
  }
  const error = failure(() => pilotFixture({ environment: 'pilot', providerMode: 'catalog' }))
  expect((error as ConfigError).variables).toEqual(['ARTURIA_PROVIDER_MODE'])
})
