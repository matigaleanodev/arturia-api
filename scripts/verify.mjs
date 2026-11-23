// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { spawnSync } from 'node:child_process'

const [mode, ...filters] = process.argv.slice(2)
const local = mode === '--local'
if (mode && !local) throw new Error('Use the individual test scripts to filter verification')

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this script via npm run verify or npm run verify:local')
const scripts = ['test:contract', 'test:unit', 'test:infra', 'build']
if (local) scripts.push('test:integration')

for (const script of scripts) {
  const args = [npm, 'run', script]
  if (script === 'test:integration' && filters.length) args.push('--', ...filters)
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    break
  }
}
