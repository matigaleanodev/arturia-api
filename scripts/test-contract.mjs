// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const suite = fileURLToPath(new URL('./check-contract.mjs', import.meta.url))
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), suite], {
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
