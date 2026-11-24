// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// SSE smoke test against an already deployed pilot (13.10) or the local rehearsal harness. It only uses
// the public contract with an operator-provided access token: it creates one synthetic conversation and
// turn, never creates infrastructure, never writes files and never prints the token or the API URL.

import { randomUUID } from 'node:crypto'

export class SmokeError extends Error { override name = 'SmokeError' }

export interface SmokeConfig {
  readonly apiUrl: URL
  readonly token: string
  readonly scopeId: string
  readonly expectBlocks: number
  readonly timeoutMs: number
}
type Env = Readonly<Record<string, string | undefined>>
export interface SmokeDeps {
  fetch: typeof fetch
  now(): number
  out(line: string): void
  /** Pause before reconnecting after a connection the server closed (SSE throttle: 1 rps, burst 4). */
  sleep?(ms: number): Promise<void>
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
/** Minimum gap between the first visible block and the terminal status (plan 13.9). */
export const FIRST_BEFORE_TERMINAL_MS = 500
/** Wait after a connection closed by the server without a terminal status (24 s close, cold start). */
export const RECONNECT_PAUSE_MS = 1_000
const TERMINAL = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'blocked'])

/** Explicit target only: no defaults, no config files, HTTPS outside loopback, the token from the environment. */
export function readSmokeConfig(env: Env): SmokeConfig {
  const raw = env.ARTURIA_SMOKE_API_URL?.trim()
  const token = env.ARTURIA_SMOKE_ACCESS_TOKEN?.trim()
  if (!raw || !token) throw new SmokeError('Faltan ARTURIA_SMOKE_API_URL y ARTURIA_SMOKE_ACCESS_TOKEN: la prueba no tiene destino implícito')
  let apiUrl: URL
  try { apiUrl = new URL(raw) } catch { throw new SmokeError('ARTURIA_SMOKE_API_URL no es una URL válida') }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new SmokeError('ARTURIA_SMOKE_API_URL no admite credenciales, query ni fragmento')
  }
  const loopback = LOOPBACK.has(apiUrl.hostname)
  if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && loopback && env.ARTURIA_SMOKE_ALLOW_LOOPBACK === '1')) {
    throw new SmokeError('ARTURIA_SMOKE_API_URL debe usar HTTPS (HTTP solo en loopback con ARTURIA_SMOKE_ALLOW_LOOPBACK=1)')
  }
  if (!/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(token)) throw new SmokeError('ARTURIA_SMOKE_ACCESS_TOKEN tiene un formato inválido')
  const scopeId = env.ARTURIA_SMOKE_SCOPE?.trim() || 'personal'
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scopeId)) throw new SmokeError('ARTURIA_SMOKE_SCOPE inválido')
  const expectBlocks = Number(env.ARTURIA_SMOKE_EXPECT_BLOCKS ?? 3)
  const timeoutMs = Number(env.ARTURIA_SMOKE_TIMEOUT_MS ?? 120_000)
  if (!Number.isSafeInteger(expectBlocks) || expectBlocks < 1 || expectBlocks > 100) throw new SmokeError('ARTURIA_SMOKE_EXPECT_BLOCKS inválido')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 600_000) throw new SmokeError('ARTURIA_SMOKE_TIMEOUT_MS inválido')
  if (!apiUrl.pathname.endsWith('/')) apiUrl.pathname += '/'
  return { apiUrl, token, scopeId, expectBlocks, timeoutMs }
}

interface SseEvent { readonly event: string; readonly data: Record<string, unknown> }
async function* readEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) as Record<string, unknown> }
    }
  }
}

/**
 * Accepts one synthetic turn, reads its events, disconnects right after the first block and resumes with
 * the cursor until the terminal status. Checks contiguous sequences without duplicates, the expected block
 * count, the gap between the first block and the terminal and the persisted snapshot. Provider attempts are
 * not visible through the API: in AWS they are read with `pilot:inspect --turn` (claims must be 1).
 */
export async function runSseSmoke(config: SmokeConfig, deps: SmokeDeps): Promise<number> {
  const deadline = AbortSignal.timeout(config.timeoutMs)
  const url = (path: string) => new URL(path, config.apiUrl)
  const authorization = `Bearer ${config.token}`
  const scope = `v1/scopes/${encodeURIComponent(config.scopeId)}`
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await deps.fetch(url(path), { method, redirect: 'error', signal: deadline,
      headers: { Authorization: authorization, 'Content-Type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const json = await response.json().catch(() => ({})) as Record<string, unknown>
    // Only the status and the public error code are reported, with IDs elided.
    if (!response.ok) {
      throw new SmokeError(`${method} ${path.replace(/[0-9a-f-]{36}/g, '<id>')} devolvió ${response.status} ${String(json.code ?? '')}`.trim())
    }
    return json
  }
  const report: Record<string, unknown> = { ok: false, scopeId: config.scopeId }
  try {
    const conversation = await call('POST', `${scope}/conversations`, { title: 'Prueba de humo sintética' })
    const accepted = deps.now()
    const turn = await call('POST', `${scope}/conversations/${String(conversation.conversationId)}/turns`,
      { text: 'Prueba de humo sintética: sin datos reales.' }, { 'Idempotency-Key': randomUUID() })
    const turnId = String(turn.turnId)
    report.turnId = turnId
    const seqs: number[] = []
    let firstAt: number | undefined
    let terminal: Record<string, unknown> | undefined
    let terminalAt = 0
    let connections = 0
    let cutDone = false
    let resumed = false
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    while (!terminal) {
      if (deadline.aborted) throw new SmokeError('Se agotó el tiempo de la prueba sin estado terminal')
      if (++connections > 20) throw new SmokeError('Demasiadas reconexiones sin estado terminal')
      const cut = new AbortController()
      const after = seqs.at(-1) ?? 0
      const response = await deps.fetch(url(`${scope}/turns/${turnId}/events?after=${after}`), {
        headers: { Authorization: authorization, Accept: 'text/event-stream' }, redirect: 'error',
        signal: AbortSignal.any([deadline, cut.signal]) })
      if (response.status !== 200 || !response.body) throw new SmokeError(`SSE devolvió ${response.status}`)
      if (!/^text\/event-stream/.test(response.headers.get('content-type') ?? '')) throw new SmokeError('SSE sin text/event-stream')
      try {
        for await (const { event, data } of readEvents(response.body as unknown as AsyncIterable<Uint8Array>)) {
          if (event === 'text') {
            const seq = Number(data.seq)
            if (seq !== (seqs.at(-1) ?? 0) + 1) throw new SmokeError(`Secuencia no contigua o duplicada: ${seq} después de ${seqs.at(-1) ?? 0}`)
            seqs.push(seq)
            firstAt ??= deps.now()
            if (after > 0) resumed = true
            // Cut right after the first block, on whichever connection it arrives: the turn keeps running server-side.
            if (!cutDone && seqs.length === 1) { cutDone = true; cut.abort(); break }
          } else if (event === 'status' && TERMINAL.has(String(data.status))) {
            terminal = data
            terminalAt = deps.now()
            break
          }
        }
      } catch (error) {
        if (!cut.signal.aborted) throw error
      }
      if (!terminal && !cut.signal.aborted) await sleep(RECONNECT_PAUSE_MS)
    }
    const snapshot = await call('GET', `${scope}/turns/${turnId}`)
    Object.assign(report, {
      status: terminal.status, blocks: seqs.length, reconnections: connections - 1,
      acceptToFirstMs: firstAt === undefined ? null : firstAt - accepted, acceptToTerminalMs: terminalAt - accepted,
      firstBeforeTerminalMs: firstAt === undefined ? null : terminalAt - firstAt,
    })
    const failures: string[] = []
    if (terminal.status !== 'completed' || snapshot.status !== 'completed') failures.push('el turno no terminó en completed')
    if (seqs.length !== config.expectBlocks || terminal.lastSeq !== config.expectBlocks || snapshot.lastSeq !== config.expectBlocks) {
      failures.push(`se esperaban ${config.expectBlocks} bloques`)
    }
    // A terminal after the cut also proves the resumption when every remaining block was already read with after > 0.
    if (!resumed && !(cutDone && seqs.length === 1)) failures.push('no se ejercitó la reconexión con cursor')
    if (firstAt === undefined || terminalAt - firstAt < FIRST_BEFORE_TERMINAL_MS) failures.push('el primer bloque no llegó antes del terminal')
    report.ok = failures.length === 0
    if (failures.length) report.failures = failures
    deps.out(JSON.stringify(report))
    return report.ok ? 0 : 1
  } catch (error) {
    report.error = error instanceof SmokeError ? error.message : error instanceof Error ? error.name : 'Error'
    deps.out(JSON.stringify(report))
    return 1
  }
}

export async function runSmokeCli(env: Env, deps: SmokeDeps): Promise<number> {
  let config: SmokeConfig
  try { config = readSmokeConfig(env) } catch (error) {
    deps.out(JSON.stringify({ ok: false, error: error instanceof SmokeError ? error.message : 'Configuración inválida' }))
    return 1
  }
  return runSseSmoke(config, deps)
}
