// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { pilotFixture, FIXTURE_BLOCKS, FIXTURE_INTERVAL_MS } from '../models/fixture-provider.js'
import { ConfigError, loadCatalogRuntime, loadHttpRuntime, loadLedgerRuntime, loadWorkerRuntime, memoize } from './runtime.js'

const http = { ARTURIA_TABLE_NAME: 'arturia-pilot-table', ARTURIA_CLIENT_ID: 'fixtureclient0123456789abcd',
  ARTURIA_ALLOWED_ORIGIN: 'https://d111111abcdef8.cloudfront.net' }
const worker = { ARTURIA_TABLE_NAME: 'arturia-pilot-table', ARTURIA_ENVIRONMENT: 'pilot', ARTURIA_PROVIDER_MODE: 'fixture' }
const failure = (load: () => unknown) => {
  try { load() } catch (error) { return error }
  throw new Error('Expected a configuration failure')
}

test('config_missing_or_invalid_fails_closed', () => {
  expect(loadHttpRuntime(http)).toEqual({ tableName: http.ARTURIA_TABLE_NAME, clientId: http.ARTURIA_CLIENT_ID,
    allowedOrigin: http.ARTURIA_ALLOWED_ORIGIN })
  expect(loadWorkerRuntime(worker)).toEqual({ tableName: worker.ARTURIA_TABLE_NAME, environment: 'pilot', providerMode: 'fixture' })
  const cases: [() => unknown, string[]][] = [
    [() => loadHttpRuntime({}), ['ARTURIA_TABLE_NAME', 'ARTURIA_CLIENT_ID', 'ARTURIA_ALLOWED_ORIGIN']],
    [() => loadHttpRuntime({ ...http, ARTURIA_ALLOWED_ORIGIN: '*' }), ['ARTURIA_ALLOWED_ORIGIN']],
    [() => loadHttpRuntime({ ...http, ARTURIA_TABLE_NAME: ' ' }), ['ARTURIA_TABLE_NAME']],
    [() => loadHttpRuntime({ ...http, ARTURIA_TABLE_NAME: 'tabla con espacios' }), ['ARTURIA_TABLE_NAME']],
    [() => loadHttpRuntime({ ...http, ARTURIA_CLIENT_ID: 'Bearer secret-value!' }), ['ARTURIA_CLIENT_ID']],
    [() => loadWorkerRuntime({}), ['ARTURIA_TABLE_NAME', 'ARTURIA_ENVIRONMENT', 'ARTURIA_PROVIDER_MODE']],
    [() => loadWorkerRuntime({ ...worker, ARTURIA_PROVIDER_MODE: 'catalogo' }), ['ARTURIA_PROVIDER_MODE']],
    [() => loadWorkerRuntime({ ...worker, ARTURIA_PROVIDER_MODE: 'FIXTURE' }), ['ARTURIA_PROVIDER_MODE']],
    [() => loadWorkerRuntime({ ...worker, ARTURIA_ENVIRONMENT: 'Pilot!' }), ['ARTURIA_ENVIRONMENT']],
  ]
  for (const [load, variables] of cases) {
    const error = failure(load)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variables).toEqual(variables)
    // Messages name variables only, never the rejected values.
    for (const value of ['tabla con espacios', 'Bearer secret-value!', 'catalogo', 'Pilot!']) {
      expect((error as Error).message).not.toContain(value)
    }
  }
})

test('ledger_config_fails_closed_and_must_be_a_separate_table', () => {
  const ok = { ...worker, ARTURIA_LEDGER_TABLE_NAME: 'arturia-pilot-ledger' }
  expect(loadLedgerRuntime(ok)).toEqual({ ledgerTableName: 'arturia-pilot-ledger' })
  const cases: Array<Record<string, string>> = [
    worker, { ...ok, ARTURIA_LEDGER_TABLE_NAME: ' ' }, { ...ok, ARTURIA_LEDGER_TABLE_NAME: 'con espacios' },
    // Sharing the chat table would let recreating it reset the monthly consumption.
    { ...ok, ARTURIA_LEDGER_TABLE_NAME: worker.ARTURIA_TABLE_NAME },
  ]
  for (const env of cases) {
    const error = failure(() => loadLedgerRuntime(env))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variables).toEqual(['ARTURIA_LEDGER_TABLE_NAME'])
    expect((error as Error).message).not.toContain('con espacios')
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

const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:arturia-pilot/providers-AbCdEf'
const catalogEnv = { ...worker, ARTURIA_PROVIDER_MODE: 'catalog', ARTURIA_LEDGER_TABLE_NAME: 'arturia-ledger',
  ARTURIA_PROVIDER_SECRET_ARN: arn, ARTURIA_MODEL: 'gpt-6-luna', ARTURIA_TARIFF_VERIFIED_AT: '2026-11-20' }

test('runtime_catalog_config_requires_secret_arn', () => {
  expect(loadWorkerRuntime(catalogEnv).providerMode).toBe('catalog')
  expect(loadCatalogRuntime(catalogEnv)).toEqual({ secretArn: arn, model: 'gpt-6-luna', tariffVerifiedAt: '2026-11-20' })
  const bad: [Record<string, string>, string[]][] = [
    [{ ...catalogEnv, ARTURIA_PROVIDER_SECRET_ARN: '' }, ['ARTURIA_PROVIDER_SECRET_ARN']],
    [{ ...catalogEnv, ARTURIA_PROVIDER_SECRET_ARN: arn.replace('providers', 'other') }, ['ARTURIA_PROVIDER_SECRET_ARN']],
    [{ ...catalogEnv, ARTURIA_MODEL: 'gpt-4' }, ['ARTURIA_MODEL']],
    [{ ...catalogEnv, ARTURIA_TARIFF_VERIFIED_AT: '2026-13-40' }, ['ARTURIA_TARIFF_VERIFIED_AT']],
    [{ ...catalogEnv, ARTURIA_TARIFF_VERIFIED_AT: '2030-01-01' }, ['ARTURIA_TARIFF_VERIFIED_AT']],
    // Tomorrow's date would pass startup but every send would be denied until then.
    [{ ...catalogEnv, ARTURIA_TARIFF_VERIFIED_AT: '2026-11-26' }, ['ARTURIA_TARIFF_VERIFIED_AT']],
  ]
  for (const [env, variables] of bad) {
    const error = failure(() => loadCatalogRuntime(env, new Date('2026-11-25T00:00:00Z')))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).variables).toEqual(variables)
    expect((error as Error).message).not.toContain('gpt-4')
  }
  // A model of a disabled provider is a configuration error, as is any model outside the catalog.
  const disabled = failure(() => loadCatalogRuntime({ ...catalogEnv, ARTURIA_MODEL: 'claude-sonnet-5-5' }, new Date('2026-11-25T00:00:00Z')))
  expect((disabled as ConfigError).variables).toEqual(['ARTURIA_MODEL'])
  const missing = failure(() => loadCatalogRuntime(worker))
  expect((missing as ConfigError).variables).toEqual(['ARTURIA_PROVIDER_SECRET_ARN', 'ARTURIA_MODEL', 'ARTURIA_TARIFF_VERIFIED_AT'])
})
