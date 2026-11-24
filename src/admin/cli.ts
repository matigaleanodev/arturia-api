// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Operator CLIs for the pilot. The default mode never writes. Writing modes require an explicit
// table, region, profile and expected account, and confirm the account from the table ARN first.
// Output is one JSON line; the Cognito subject is masked and SDK errors are reported by name only.

import { parseArgs } from 'node:util'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { ChatStore } from '../chat/turns.store.js'
import { sqsTurnQueue, type TurnQueue } from '../jobs/outbox.js'
import { inspectTurn, staleTurns } from './inspect.js'
import { pendingOutboxFor, republishOutbox } from './outbox-recovery.js'
import { AdminError, PILOT_SCOPE_ACTIONS, PILOT_SCOPE_IDS, applyProvision, assertSubject, confirmTable, readProvision,
  type AwsTarget } from './provision.js'

export interface OperatorTarget extends AwsTarget { readonly profile: string }
type Env = Readonly<Record<string, string | undefined>>
interface BaseDeps {
  createClient(target: OperatorTarget): DynamoDBClient
  out(line: string): void
}
export interface ProvisionDeps extends BaseDeps { now(): number }
export interface InspectDeps extends BaseDeps { now(): number }
export interface RepublishDeps extends BaseDeps {
  createQueue(target: OperatorTarget, queueUrl: string): TurnQueue & { close?(): void }
}

/**
 * `mfaVerifiedAt` comes from the operator's clock. Moving it forward means a clock behind AWS can
 * never accept a sign-in from before the activation; a clock ahead only delays the new sign-in.
 */
export const MFA_CLOCK_MARGIN_SECONDS = 60
const ENDPOINT_OVERRIDES = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_DYNAMODB', 'AWS_ENDPOINT_URL_SQS']
const targetOptions = {
  table: { type: 'string' }, region: { type: 'string' }, profile: { type: 'string' }, 'expected-account': { type: 'string' },
} as const

function refuseEnvironment(env: Env) {
  const mode = env.ARTURIA_IDENTITY_MODE
  if (mode !== undefined && mode !== 'cognito') throw new AdminError('Operación rechazada con el modo de identidad sintética')
  const override = ENDPOINT_OVERRIDES.find(name => env[name])
  if (override) throw new AdminError(`Operación rechazada: ${override} redirige el SDK a otro endpoint`)
}

function readTarget(values: Partial<Record<keyof typeof targetOptions, string>>): OperatorTarget {
  const { table, region, profile } = values
  const account = values['expected-account']
  const missing = Object.entries({ '--table': table, '--region': region, '--profile': profile, '--expected-account': account })
    .filter(([, value]) => !value).map(([flag]) => flag)
  if (missing.length) throw new AdminError('Faltan parámetros explícitos: ' + missing.join(', '))
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table!)) throw new AdminError('--table inválido')
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(region!)) throw new AdminError('--region inválido')
  if (!/^[A-Za-z0-9_.+=,@-]{1,64}$/.test(profile!)) throw new AdminError('--profile inválido')
  if (!/^\d{12}$/.test(account!)) throw new AdminError('--expected-account debe tener 12 dígitos')
  return { tableName: table!, region: region!, profile: profile!, account: account! }
}

const mask = (subject: string) => subject.slice(0, 8) + '…'

async function run(out: (line: string) => void, body: () => Promise<number>) {
  try {
    return await body()
  } catch (error) {
    // AdminError messages are ours; SDK messages can carry ARNs with the account, so only the name is shown.
    const message = error instanceof AdminError ? error.message
      : error instanceof Error ? error.name : 'Error'
    out(JSON.stringify({ error: message }))
    return 1
  }
}

export function runProvision(argv: readonly string[], env: Env, deps: ProvisionDeps): Promise<number> {
  return run(deps.out, async () => {
    refuseEnvironment(env)
    let parsed
    try {
      parsed = parseArgs({ args: [...argv], strict: true, allowPositionals: false, options: {
        sub: { type: 'string' }, apply: { type: 'boolean' }, check: { type: 'boolean' },
        'confirm-totp-enrolled': { type: 'boolean' }, 'model-grants': { type: 'boolean' }, ...targetOptions,
      } })
    } catch { throw new AdminError('Argumentos inválidos') }
    const { values } = parsed
    if (values['model-grants']) throw new AdminError('--model-grants está reservado para la subtarea 13.14 y no está disponible')
    if (!values.sub) throw new AdminError('Falta --sub')
    assertSubject(values.sub)
    if (values.apply && values.check) throw new AdminError('Usá --apply o --check, no ambos')
    const subject = mask(values.sub)

    if (!values.apply && !values.check) {
      deps.out(JSON.stringify({ mode: 'dry-run', subject, access: 'sin lecturas ni escrituras',
        ensures: ['SUBJECT', 'ACCOUNT (active, mfaVerifiedAt al aplicar)', ...PILOT_SCOPE_IDS.map(id => 'SCOPE#' + id)],
        actions: PILOT_SCOPE_ACTIONS, modelGrants: 'no se escriben' }))
      return 0
    }
    const target = readTarget(values)
    if (values.apply && !values['confirm-totp-enrolled']) {
      throw new AdminError('--apply requiere --confirm-totp-enrolled después de verificar el enrolamiento TOTP en Cognito')
    }
    const client = deps.createClient(target)
    try {
      await confirmTable(client, target)
      const db = DynamoDBDocumentClient.from(client)
      if (values.check) {
        const report = await readProvision(db, target.tableName, values.sub)
        deps.out(JSON.stringify({ mode: 'check', subject, ...report }))
        return report.status === 'complete' ? 0 : 2
      }
      const result = await applyProvision(db, target.tableName, values.sub,
        { mfaVerifiedAt: deps.now() + MFA_CLOCK_MARGIN_SECONDS })
      deps.out(JSON.stringify({ mode: 'apply', subject, status: result.status, userId: result.userId,
        written: result.written, modelGrants: result.modelGrants }))
      return 0
    } finally {
      client.destroy()
    }
  })
}

// Only the turn queue: a dead-letter queue would mark the outbox published without delivering the turn.
const QUEUE_URL = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/[A-Za-z0-9_-]{0,70}turns\.fifo$/

export function runRepublish(argv: readonly string[], env: Env, deps: RepublishDeps): Promise<number> {
  return run(deps.out, async () => {
    refuseEnvironment(env)
    let parsed
    try {
      parsed = parseArgs({ args: [...argv], strict: true, allowPositionals: false, options: {
        sub: { type: 'string' }, scope: { type: 'string', multiple: true }, apply: { type: 'boolean' },
        'queue-url': { type: 'string' }, ...targetOptions,
      } })
    } catch { throw new AdminError('Argumentos inválidos') }
    const { values } = parsed
    if (!values.sub) throw new AdminError('Falta --sub')
    assertSubject(values.sub)
    const scopeIds = values.scope ?? [...PILOT_SCOPE_IDS]
    if (!scopeIds.every(id => (PILOT_SCOPE_IDS as readonly string[]).includes(id))) {
      throw new AdminError('--scope debe ser ' + PILOT_SCOPE_IDS.join(' o '))
    }
    const target = readTarget(values)
    const queueUrl = values['queue-url']
    if (values.apply) {
      const match = queueUrl ? QUEUE_URL.exec(queueUrl) : null
      if (!match) throw new AdminError('--apply requiere --queue-url de una cola FIFO de SQS')
      if (match[1] !== target.region || match[2] !== target.account) {
        throw new AdminError('La cola no pertenece a la cuenta y región esperadas')
      }
    }
    const client = deps.createClient(target)
    try {
      await confirmTable(client, target)
      const store = new ChatStore(client, target.tableName)
      const userId = await store.findUserIdBySubject(values.sub)
      if (!userId) throw new AdminError('El sub no está aprovisionado')
      const refs = await pendingOutboxFor(store, userId, scopeIds)
      const subject = mask(values.sub)
      if (!values.apply) {
        deps.out(JSON.stringify({ mode: 'dry-run', subject, pending: refs.length,
          turns: refs.map(({ scopeId, turnId }) => ({ scopeId, turnId })) }))
        return 0
      }
      const queue = deps.createQueue(target, queueUrl!)
      try {
        const result = await republishOutbox(store, queue, refs)
        deps.out(JSON.stringify({ mode: 'apply', subject, pending: refs.length, ...result }))
        return 0
      } finally {
        queue.close?.()
      }
    } finally {
      client.destroy()
    }
  })
}

/** Minimum and maximum `--older-than-minutes`: below the worker's retry window every live turn would look stale. */
export const STALE_MINUTES = { default: 60, min: 15, max: 14 * 24 * 60 } as const

/**
 * `pilot-inspect`: read-only. `--turn <id> --scope <id>` reports the claims of one turn; `--stale` lists the
 * user's non-terminal turns older than the threshold. Exit 2 when stale turns exist. There is no writing mode.
 */
export function runInspect(argv: readonly string[], env: Env, deps: InspectDeps): Promise<number> {
  return run(deps.out, async () => {
    refuseEnvironment(env)
    let parsed
    try {
      parsed = parseArgs({ args: [...argv], strict: true, allowPositionals: false, options: {
        sub: { type: 'string' }, scope: { type: 'string', multiple: true }, turn: { type: 'string' },
        stale: { type: 'boolean' }, 'older-than-minutes': { type: 'string' }, ...targetOptions,
      } })
    } catch { throw new AdminError('Argumentos inválidos') }
    const { values } = parsed
    if (!values.sub) throw new AdminError('Falta --sub')
    assertSubject(values.sub)
    if (Boolean(values.stale) === Boolean(values.turn)) throw new AdminError('Usá --stale o --turn <id>, uno de los dos')
    const scopeIds = [...new Set(values.scope ?? PILOT_SCOPE_IDS)]
    if (!scopeIds.every(id => (PILOT_SCOPE_IDS as readonly string[]).includes(id))) {
      throw new AdminError('--scope debe ser ' + PILOT_SCOPE_IDS.join(' o '))
    }
    if (values.turn !== undefined && (scopeIds.length !== 1 || !/^[0-9a-f-]{36}$/.test(values.turn))) {
      throw new AdminError('--turn requiere un ID de turno válido y un único --scope')
    }
    const minutes = values['older-than-minutes'] === undefined ? STALE_MINUTES.default : Number(values['older-than-minutes'])
    if (!Number.isSafeInteger(minutes) || minutes < STALE_MINUTES.min || minutes > STALE_MINUTES.max) {
      throw new AdminError(`--older-than-minutes debe estar entre ${STALE_MINUTES.min} y ${STALE_MINUTES.max}`)
    }
    const target = readTarget(values)
    const client = deps.createClient(target)
    try {
      await confirmTable(client, target)
      const store = new ChatStore(client, target.tableName)
      const userId = await store.findUserIdBySubject(values.sub)
      if (!userId) throw new AdminError('El sub no está aprovisionado')
      const subject = mask(values.sub)
      const now = deps.now()
      if (values.turn) {
        const turn = await inspectTurn(store, { userId, scopeId: scopeIds[0]!, turnId: values.turn }, now)
        if (!turn) throw new AdminError('El turno no existe en ese ámbito')
        deps.out(JSON.stringify({ mode: 'turn', subject, turn }))
        return 0
      }
      const turns = await staleTurns(store, userId, scopeIds, { olderThanMs: minutes * 60_000, now })
      deps.out(JSON.stringify({ mode: 'stale', subject, olderThanMinutes: minutes, count: turns.length, turns }))
      return turns.length ? 2 : 0
    } finally {
      client.destroy()
    }
  })
}

/** Real AWS clients: explicit region and profile, no endpoint overrides (refused above). */
export function awsProvisionDeps(): ProvisionDeps {
  return {
    createClient: ({ region, profile }) => new DynamoDBClient({ region, profile, maxAttempts: 3 }),
    now: () => Math.floor(Date.now() / 1_000),
    out: line => process.stdout.write(line + '\n'),
  }
}
export function awsRepublishDeps(): RepublishDeps {
  return {
    createClient: ({ region, profile }) => new DynamoDBClient({ region, profile, maxAttempts: 3 }),
    createQueue: ({ region, profile }, queueUrl) => {
      const sqs = new SQSClient({ region, profile, maxAttempts: 3 })
      return { ...sqsTurnQueue(sqs, queueUrl), close: () => sqs.destroy() }
    },
    out: line => process.stdout.write(line + '\n'),
  }
}
export function awsInspectDeps(): InspectDeps {
  return {
    createClient: ({ region, profile }) => new DynamoDBClient({ region, profile, maxAttempts: 3 }),
    now: () => Date.now(),
    out: line => process.stdout.write(line + '\n'),
  }
}
