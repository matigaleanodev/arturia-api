// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { BUNDLES } from './delivery.ts'

const dirs: string[] = []
const build = () => {
  const outdir = mkdtempSync(join(tmpdir(), 'arturia-bundles-'))
  dirs.push(outdir)
  execFileSync(process.execPath, ['scripts/bundle.mjs', '--outdir', outdir], { stdio: 'pipe', timeout: 60_000 })
  return outdir
}
let first: string
beforeAll(() => { first = build() }, 70_000)
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

const bundleFile = (outdir: string, name: string) => join(outdir, name, 'index.cjs')

test('bundle_entries_are_runtime_sources_only', () => {
  expect(Object.keys(BUNDLES).sort()).toEqual(['http', 'relay', 'stream', 'worker'])
  for (const entry of Object.values(BUNDLES)) {
    expect(normalize(entry).startsWith('src/')).toBe(true)
    expect(entry).not.toMatch(/\.spec\.ts$/)
  }
})

test('each_bundle_exports_handler', () => {
  for (const name of Object.keys(BUNDLES)) {
    // The streaming runtime global only exists inside Lambda; the stub lets the module load.
    const probe = `globalThis.awslambda={streamifyResponse:h=>h,HttpResponseStream:{from:o=>o}};` +
      `const m=require(${JSON.stringify(bundleFile(first, name))});process.stdout.write(typeof m.handler)`
    const type = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH ?? '', AWS_REGION: 'us-east-1' } })
    expect(type, name).toBe('function')
  }
}, 30_000)

test('bundles_exclude_synthetic_identity', () => {
  const markers = ['resolveLocalActor', 'provisionIdentities', 'integrated.a.local', 'integrated.b.local',
    'synthetic-local-only', 'ArturiaLocal', 'ARTURIA_IDENTITY_MODE', 'fixture-user-']
  // Positive control: every marker still names real synthetic-identity code.
  const support = ['chat-web.ts', 'local-database.ts', 'fixtures.ts'].map(file => readFileSync(join('tests/support', file), 'utf8')).join('\n')
    + readFileSync('infra/identity.spec.ts', 'utf8')
  for (const marker of markers) expect(support.includes(marker), marker).toBe(true)
  for (const name of Object.keys(BUNDLES)) {
    const code = readFileSync(bundleFile(first, name), 'utf8')
    for (const marker of markers) expect(code.includes(marker), `${name} contains ${marker}`).toBe(false)
  }
})

test('bundles_are_reproducible', () => {
  const second = build()
  const digest = (dir: string, name: string) => createHash('sha256').update(readFileSync(bundleFile(dir, name))).digest('hex')
  for (const name of Object.keys(BUNDLES)) expect(digest(second, name), name).toBe(digest(first, name))
  for (const name of Object.keys(BUNDLES)) expect(readFileSync(bundleFile(first, name), 'utf8')).not.toContain(process.cwd())
}, 70_000)
