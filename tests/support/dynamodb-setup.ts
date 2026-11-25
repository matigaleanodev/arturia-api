// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import type { TestProject } from 'vitest/node'
import { createLocalDatabase } from './local-database.ts'

export default async function setup(project: TestProject) {
  const database = createLocalDatabase()
  const onInterrupt = () => { try { database.down() } finally { process.exit(130) } }
  const onTerminate = () => { try { database.down() } finally { process.exit(143) } }
  process.prependOnceListener('SIGINT', onInterrupt)
  process.prependOnceListener('SIGTERM', onTerminate)
  process.once('exit', database.down)
  function teardown() {
    database.down()
    process.off('exit', database.down)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
  try {
    project.provide('integrationDatabase', await database.start())
    return teardown
  } catch (error) {
    teardown()
    throw error
  }
}
