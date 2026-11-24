// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// SSE smoke test of a deployed pilot. Requires ARTURIA_SMOKE_API_URL (stage URL) and ARTURIA_SMOKE_ACCESS_TOKEN
// (a test user's access token, never persisted). Creates no resources and writes no files.
// Run with `npm run smoke:sse:aws`.
const { runSmokeCli } = await import('../dist/src/smoke/sse-smoke.js')
process.exitCode = await runSmokeCli(process.env, { fetch, now: () => Date.now(), out: line => process.stdout.write(line + '\n') })
