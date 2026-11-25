// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Provisions the pilot user and scopes. Dry run by default; see `src/admin/cli.ts` for the modes.
// Run with `npm run provision:pilot -- --sub <cognito-sub> [--check | --apply ...]`, which compiles first.
const { runProvision, awsProvisionDeps } = await import('../dist/src/admin/cli.js')
process.exitCode = await runProvision(process.argv.slice(2), process.env, awsProvisionDeps())
