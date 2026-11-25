// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { applyProvision } from '../../src/admin/provision.js'
import { inspectTurn } from '../../src/admin/inspect.js'
import { ChatStore } from '../../src/chat/turns.store.js'
import { readSmokeConfig, runSmokeCli, runSseSmoke, type SmokeConfig } from '../../src/smoke/sse-smoke.js'
import { integrationDatabase } from '../support/dynamodb.js'
import { startSmokeServer } from '../support/smoke-server.js'

const TOKEN = 'smoke-token-' + randomUUID().replaceAll('-', '')
const OTHER = 'other-token-' + randomUUID().replaceAll('-', '')
let store: ChatStore
let server: Awaited<ReturnType<typeof startSmokeServer>>
let userId: string

beforeAll(async () => {
  const local = integrationDatabase()
  store = new ChatStore(local.client, local.tableName)
  const grants: Record<string, { actor: { userId: string; sessionId: string }; scopeIds: string[] }> = {}
  for (const token of [TOKEN, OTHER]) {
    const { userId: id } = await applyProvision(store.db, store.tableName, randomUUID(), { mfaVerifiedAt: 1 })
    const sessionId = 'smoke-session-' + randomUUID()
    await store.registerSession(id!, sessionId, 2)
    grants[token] = { actor: { userId: id!, sessionId }, scopeIds: ['personal', 'work'] }
  }
  userId = grants[TOKEN]!.actor.userId
  server = await startSmokeServer(store, grants)
})
afterAll(async () => { await server?.close() })

const env = (extra: Record<string, string> = {}) => ({
  ARTURIA_SMOKE_API_URL: server.url, ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN, ARTURIA_SMOKE_ALLOW_LOOPBACK: '1', ...extra })
function capture() {
  const lines: string[] = []
  return { lines, deps: { fetch, now: () => Date.now(), out: (line: string) => lines.push(line) } }
}

describe('smoke_refuses_without_explicit_target', () => {
  test('configuration is explicit and never falls back to defaults', () => {
    const refusals: Record<string, string | undefined>[] = [
      {},
      { ARTURIA_SMOKE_API_URL: 'https://abc.execute-api.us-east-1.amazonaws.com/v1/' },
      { ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN },
      { ARTURIA_SMOKE_API_URL: 'http://abc.execute-api.us-east-1.amazonaws.com/v1/', ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN },
      { ARTURIA_SMOKE_API_URL: 'http://127.0.0.1:9/', ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN },
      { ARTURIA_SMOKE_API_URL: 'https://user:pw@example.com/', ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN },
      { ARTURIA_SMOKE_API_URL: 'https://example.com/?token=x', ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN },
      { ARTURIA_SMOKE_API_URL: 'https://example.com/', ARTURIA_SMOKE_ACCESS_TOKEN: 'short' },
      { ARTURIA_SMOKE_API_URL: 'https://example.com/', ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN, ARTURIA_SMOKE_SCOPE: '../x' },
    ]
    for (const values of refusals) expect(() => readSmokeConfig(values), JSON.stringify(Object.keys(values))).toThrow()
    const config = readSmokeConfig({ ARTURIA_SMOKE_API_URL: 'https://abc.execute-api.us-east-1.amazonaws.com/v1', ARTURIA_SMOKE_ACCESS_TOKEN: TOKEN })
    expect(config).toMatchObject({ scopeId: 'personal', expectBlocks: 3 })
    expect(config.apiUrl.href).toBe('https://abc.execute-api.us-east-1.amazonaws.com/v1/')
  })

  test('the cli exits before any request without a target', async () => {
    const fetchSpy = vi.fn()
    const lines: string[] = []
    expect(await runSmokeCli({}, { fetch: fetchSpy as never, now: Date.now, out: line => lines.push(line) })).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false })
    // The npm entry point refuses too, without network or credentials.
    const script = spawnSync(process.execPath, ['scripts/smoke-sse.mjs'], { encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH ?? '' } })
    expect(script.status).toBe(1)
    expect(script.stdout).toContain('ARTURIA_SMOKE_API_URL')
  }, 30_000)
})

describe('rehearsal against the local api with the pilot fixture', () => {
  test('reconnect_has_one_provider_attempt and durable_chat_survives_disconnect', async () => {
    const { lines, deps } = capture()
    expect(await runSmokeCli(env(), deps), lines.join('\n')).toBe(0)
    const report = JSON.parse(lines.at(-1)!)
    // Three blocks one second apart: the first is visible well before the terminal.
    expect(report).toMatchObject({ ok: true, status: 'completed', blocks: 3, scopeId: 'personal' })
    expect(report.reconnections).toBeGreaterThanOrEqual(1)
    expect(report.firstBeforeTerminalMs).toBeGreaterThanOrEqual(500)
    expect(report.acceptToFirstMs).toBeLessThan(report.acceptToTerminalMs)
    // The cut after the first block did not start a second attempt: one claim, confirmed send.
    expect(await inspectTurn(store, { userId, scopeId: 'personal', turnId: report.turnId }, Date.now()))
      .toMatchObject({ status: 'completed', claims: 1, sendState: 'confirmed', lastSeq: 3 })
  }, 60_000)

  test('smoke_artifacts_contain_no_tokens', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'arturia-smoke-'))
    try {
      // Asynchronous: the rehearsal server runs in this process and must keep serving the child.
      const script = await promisify(execFile)(process.execPath, [resolve('scripts/smoke-sse.mjs')], { cwd, encoding: 'utf8',
        timeout: 60_000, env: { PATH: process.env.PATH ?? '', ...env({ ARTURIA_SMOKE_SCOPE: 'work' }) } })
      const output = script.stdout + script.stderr
      expect(output).not.toContain(TOKEN)
      expect(output).not.toContain(server.url)
      expect(JSON.parse(script.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, scopeId: 'work' })
      // Nothing persisted: no files, no cached sessions.
      expect(readdirSync(cwd)).toEqual([])
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  }, 60_000)

  test('a scope of another user or a bad token fails without leaking the token', async () => {
    const { lines, deps } = capture()
    expect(await runSmokeCli(env({ ARTURIA_SMOKE_ACCESS_TOKEN: 'unknown-token-' + 'x'.repeat(20) }), deps)).toBe(1)
    expect(JSON.parse(lines.at(-1)!).error).toMatch(/401/)
    expect(await runSmokeCli(env({ ARTURIA_SMOKE_SCOPE: 'shared' }), deps)).toBe(1)
    expect(JSON.parse(lines.at(-1)!).error).toMatch(/403/)
    expect(lines.join('\n')).not.toContain(TOKEN)
  }, 30_000)

  test('a stream without the expected blocks fails the smoke', async () => {
    const { lines, deps } = capture()
    const config: SmokeConfig = { ...readSmokeConfig(env()), expectBlocks: 4 }
    expect(await runSseSmoke(config, deps)).toBe(1)
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: false, failures: ['se esperaban 4 bloques'] })
  }, 60_000)

})
