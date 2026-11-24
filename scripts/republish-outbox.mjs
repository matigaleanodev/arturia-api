// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Republishes pending outbox intents of one provisioned user. Dry run (read-only listing) by default.
// Run with `npm run republish:outbox -- --sub <cognito-sub> ... [--apply --queue-url <url>]`.
const { runRepublish, awsRepublishDeps } = await import('../dist/src/admin/cli.js')
process.exitCode = await runRepublish(process.argv.slice(2), process.env, awsRepublishDeps())
