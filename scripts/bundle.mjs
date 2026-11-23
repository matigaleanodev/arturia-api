// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Builds one self-contained CommonJS bundle per Lambda handler: <outdir>/<name>/index.cjs.
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { build } from 'rolldown'
import { BUNDLES } from '../infra/delivery.ts'

const { values } = parseArgs({ options: { outdir: { type: 'string', default: 'dist/bundles' } } })
const outdir = resolve(values.outdir)

for (const [name, input] of Object.entries(BUNDLES)) {
  await build({
    input,
    platform: 'node',
    logLevel: 'warn',
    output: { format: 'cjs', file: join(outdir, name, 'index.cjs'), codeSplitting: false },
  })
}
