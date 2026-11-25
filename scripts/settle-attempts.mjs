// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Reconciles uncertain model reservations of one user and UTC month with the provider's exported invoice.
// Lists by default; with `--evidence <file>` it is a dry run; `--apply` settles the matched attempts.
// Run with `npm run settle:attempts -- (--sub <cognito-sub> | --all-users) --month YYYY-MM --ledger-table <name> ... [--evidence <file> [--apply]]`.
const { runSettle, awsSettleDeps } = await import('../dist/src/admin/cli.js')
process.exitCode = await runSettle(process.argv.slice(2), process.env, awsSettleDeps())
