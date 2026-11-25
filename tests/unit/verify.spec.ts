// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

function runNpm(args: string[], cwd = process.cwd()) {
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run the verification suite via npm')
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error) throw result.error
  return result
}

test('invalid_contract_fails_ci', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'arturia-contract-'))
  try {
    cpSync('package.json', join(sandbox, 'package.json'))
    cpSync('scripts', join(sandbox, 'scripts'), { recursive: true })
    cpSync('contracts', join(sandbox, 'contracts'), { recursive: true })
    symlinkSync(resolve('node_modules'), join(sandbox, 'node_modules'), 'junction')

    const path = join(sandbox, 'contracts/fixtures/chat.json')
    const fixture = JSON.parse(readFileSync(path, 'utf8'))
    delete fixture.stream.events.find((event: { type: string }) => event.type === 'text').seq
    writeFileSync(path, JSON.stringify(fixture))

    const result = runNpm(['run', 'verify'], sandbox)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('must have required property \'seq\'')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}, 12_000)

test('contract_test_selector_runs_only_the_matching_case', () => {
  const result = runNpm([
    'run', 'test:contract', '--',
    '--test-name-pattern=event_requires_sequence', '--test-reporter=tap',
  ])
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/^ok 1 - event_requires_sequence$/m)
  expect(result.stdout).toMatch(/^# tests 1$/m)
}, 12_000)
