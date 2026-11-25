// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Read-only inspection of one provisioned user's turns: claims of a turn or stale non-terminal turns.
// Run with `npm run pilot:inspect -- --sub <cognito-sub> ... (--turn <id> --scope <id> | --stale)`.
const { runInspect, awsInspectDeps } = await import('../dist/src/admin/cli.js')
process.exitCode = await runInspect(process.argv.slice(2), process.env, awsInspectDeps())
