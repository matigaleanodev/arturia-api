// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLocalDatabase } from '../tests/support/local-database.ts'

if (!process.env.ARTURIA_WEB_DIR) throw new Error('Set ARTURIA_WEB_DIR to the Angular checkout')
const web = await realpath(process.env.ARTURIA_WEB_DIR)
const api = process.cwd()
const contractFiles = ['openapi.json', 'sse.schema.json', 'fixtures/chat.json']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function digest(directory) {
  const manifest = await Promise.all(contractFiles.map(async file =>
    hash(await readFile(join(directory, file))) + '  contracts/' + file + '\n'))
  return hash(manifest.join(''))
}
const manifest = JSON.parse(await readFile('scripts/integrated-scenarios.json', 'utf8'))
const copy = join(web, 'src/app/core/api/contract')
const expected = (await readFile(join(copy, 'sha256.txt'), 'utf8')).trim()
assert.equal(expected, manifest.contractSha256, 'Integrated scenario contract digest mismatch')
assert.equal(await digest(join(api, 'contracts')), expected, 'API contract digest mismatch')
assert.equal(await digest(copy), expected, 'Angular contract digest mismatch')
console.log('Integrated contract digest:', expected)

const host = '127.0.0.1'
async function availablePort() {
  const server = createServer()
  await new Promise((res, rej) => server.once('error', rej).listen(0, host, res))
  const port = server.address().port
  await new Promise((res, rej) => server.close(err => err ? rej(err) : res()))
  return port
}

const children = []
let closing = false
const shutdown = new AbortController()
const stopped = new Promise((_, reject) =>
  shutdown.signal.addEventListener('abort', () => reject(shutdown.signal.reason), { once: true }))
stopped.catch(() => {}) // A signal may arrive while provisioning the database.
const onSignal = signal => shutdown.abort(new Error('Received ' + signal))
// npm can exit on a targeted signal before forwarding it to its lifecycle process.
const launcher = process.ppid
const parentWatch = setInterval(() => {
  if (process.ppid !== launcher) shutdown.abort(new Error('Verification launcher exited'))
}, 200).unref()
process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)

function launch(name, cwd, args, env = {}, service = false) {
  shutdown.signal.throwIfAborted()
  const child = spawn(process.execPath, args, {
    cwd, detached: true, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'],
  })
  children.push(child)
  const done = new Promise((res, rej) => {
    child.once('error', rej)
    child.once('exit', (code, signal) => {
      if (code === 0 && !service) res()
      else rej(new Error(name + ' exited with ' + (signal ?? code)))
    })
  })
  done.catch(error => { if (!closing) shutdown.abort(error) })
  return Promise.race([done, stopped])
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false }
}
async function stop(child) {
  if (!child.pid || !groupExists(child.pid)) return
  // Give the CLI a chance to close Chromium and reap its own children.
  child.kill('SIGTERM')
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (let i = 0; i < 40 && groupExists(child.pid); i++) await delay(75)
    if (!groupExists(child.pid)) return
    process.kill(-child.pid, signal)
  }
  for (let i = 0; i < 40 && groupExists(child.pid); i++) await delay(75)
  if (groupExists(child.pid)) throw new Error('Process group survived cleanup: ' + child.pid)
}

async function waitReady(url, check) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted()
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1200) })
      if (response.ok && await check(response)) return
    } catch { /* A server can still be starting. */ }
    await delay(200)
  }
  throw new Error('Readiness timed out: ' + url)
}

const database = createLocalDatabase()
let runDir, build
try {
  runDir = await mkdtemp(join(tmpdir(), 'arturia-integrated-'))
  const cache = join(api, 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  build = await mkdtemp(join(cache, 'arturia-integrated-'))
  await writeFile(join(build, 'package.json'), '{"type":"module"}')
  await launch('TypeScript', api, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.integrated.json', '--outDir', build])
  const { endpoint, tableName } = await database.start()
  const apiPort = await availablePort()
  let webPort
  do { webPort = await availablePort() } while (webPort === apiPort)
  const apiOrigin = 'http://' + host + ':' + apiPort
  const webOrigin = 'http://' + host + ':' + webPort
  launch('Local API', api, ['scripts/dev-local.mjs', build, endpoint, tableName, webOrigin, String(apiPort), runDir],
    {}, true).catch(() => {})
  launch('Angular', web, ['node_modules/@angular/cli/bin/ng.js', 'serve', '--configuration=integrated',
    '--host', host, '--port', String(webPort), '--hmr=false', '--live-reload=false',
    '--define', 'INTEGRATED_API_ORIGIN=' + JSON.stringify(apiOrigin)],
    { PORT: String(webPort), CI: 'true' }, true).catch(() => {})
  await Promise.all([
    waitReady(apiOrigin + '/healthz', async r => (await r.json()).table === tableName),
    waitReady(webOrigin, async r => (await r.text()).includes('<app-root>')),
  ])
  console.log('Integrated API and Angular ready:', apiOrigin, webOrigin)
  const reportPath = join(runDir, 'playwright.json')
  await launch('Chromium scenarios', web, ['node_modules/@playwright/test/cli.js', 'test', '--workers=1',
    '--retries=0', '--reporter=list,json', '--output', join(runDir, 'test-results')], {
    ARTURIA_INTEGRATED: '1', ARTURIA_WEB_ORIGIN: webOrigin, ARTURIA_API_ORIGIN: apiOrigin,
    ARTURIA_CONTROL_DIR: runDir, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
  })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const specs = report.suites.flatMap(suite => suite.specs)
  assert.deepEqual(specs.map(spec => spec.title).sort(), manifest.scenarios.toSorted())
  for (const spec of specs) {
    assert.deepEqual(spec.tests.flatMap(t => t.results.map(r => r.status)), ['passed'], spec.title)
  }
  shutdown.signal.throwIfAborted()
} finally {
  closing = true
  const failures = []
  for (const child of children.reverse()) {
    try { await stop(child) } catch (error) { failures.push(error) }
  }
  try { database.down() } catch (error) { failures.push(error) }
  for (const path of [build, runDir].filter(Boolean)) {
    try { await rm(path, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  clearInterval(parentWatch)
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  if (failures.length) throw new AggregateError(failures, 'Integrated fixture cleanup failed')
}
shutdown.signal.throwIfAborted()
