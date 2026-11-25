// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [build, endpoint, table, web, port, control] = process.argv.slice(2)
const { startServer } = await import(pathToFileURL(join(build, 'tests/support/local-chat-server.js')))
await startServer(endpoint, table, web, Number(port), control)
