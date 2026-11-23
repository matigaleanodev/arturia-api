// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('stack_synthesizes_cognito_without_aws_lookups', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'arturia-cdk-'))
  try {
    execFileSync(process.execPath, ['infra/bin/app.ts'], {
      env: { ...process.env, CDK_OUTDIR: outdir },
      timeout: 10_000,
    })
    const template = JSON.parse(readFileSync(join(outdir, 'Arturia.template.json'), 'utf8'))
    const assembly = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'))
    expect(Object.values(template.Resources ?? {}).map((resource) => (resource as { Type: string }).Type).sort()).toEqual([
      'AWS::Cognito::UserPool',
      'AWS::Cognito::UserPoolClient',
      'AWS::Cognito::UserPoolDomain',
      'AWS::Cognito::UserPoolResourceServer',
    ])
    expect(assembly.missing ?? []).toEqual([])
    expect(assembly.artifacts.Arturia.environment).toBe('aws://unknown-account/unknown-region')
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}, 12_000)
