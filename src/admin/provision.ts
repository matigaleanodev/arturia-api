// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Administrative provisioning of the pilot user: the Cognito subject mapping, an active account with
// the verified TOTP time and the personal and work scopes. Writes are all-or-nothing and only create
// missing rows. Existing rows are never changed: a disabled account, narrowed scope actions or a
// different subject mapping are conflicts that the operator resolves by hand. Model grants are never
// written here.

import { randomUUID } from 'node:crypto'
import { DescribeTableCommand, TransactionCanceledException, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient,
  type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import { scopePartition } from '../chat/turns.store.js'
import type { Action } from '../identity/policy.js'

export const PILOT_SCOPE_IDS = ['personal', 'work'] as const
export type PilotScopeId = (typeof PILOT_SCOPE_IDS)[number]
export const PILOT_SCOPE_ACTIONS: readonly Action[] = ['conversation:list', 'conversation:create', 'conversation:read',
  'turn:create', 'turn:read', 'turn:run', 'turn:stream', 'turn:cancel']

/** Cognito `sub`: a lowercase UUID. Rejects fixture subjects and arbitrary strings. */
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class AdminError extends Error { override name = 'AdminError' }

export type ItemKey = 'SUBJECT' | 'ACCOUNT' | `SCOPE#${PilotScopeId}`
export interface ItemReport { readonly key: ItemKey; readonly state: 'missing' | 'ok' | 'conflict'; readonly reason?: string }
export interface ProvisionReport {
  readonly status: 'absent' | 'partial' | 'complete' | 'conflict'
  readonly userId?: string
  readonly items: readonly ItemReport[]
  readonly modelGrants: 'absent' | 'present'
}

export function assertSubject(subject: string) {
  if (!SUBJECT.test(subject)) throw new AdminError('El sub de Cognito debe ser un UUID en minúsculas')
}

const userPk = (userId: string) => JSON.stringify([userId])
const sameActions = (actions: unknown) => actions instanceof Set && actions.size === PILOT_SCOPE_ACTIONS.length &&
  PILOT_SCOPE_ACTIONS.every(action => actions.has(action))

async function get(db: DynamoDBDocumentClient, TableName: string, pk: string, sk: string) {
  return (await db.send(new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }))).Item
}

/** Read-only, strongly consistent report of the subject's provisioning. */
export async function readProvision(db: DynamoDBDocumentClient, tableName: string, subject: string): Promise<ProvisionReport> {
  assertSubject(subject)
  const mapping = await get(db, tableName, 'SUBJECT', subject)
  const scopeKeys = PILOT_SCOPE_IDS.map(id => `SCOPE#${id}` as const)
  if (!mapping) {
    return { status: 'absent', modelGrants: 'absent',
      items: (['SUBJECT', 'ACCOUNT', ...scopeKeys] as const).map(key => ({ key, state: 'missing' as const })) }
  }
  const userId = mapping.userId
  if (typeof userId !== 'string' || !userId) {
    return { status: 'conflict', modelGrants: 'absent', items: [{ key: 'SUBJECT', state: 'conflict', reason: 'userId inválido' }] }
  }
  const items: ItemReport[] = [{ key: 'SUBJECT', state: 'ok' }]
  const account = await get(db, tableName, userPk(userId), 'ACCOUNT')
  if (!account) items.push({ key: 'ACCOUNT', state: 'missing' })
  else if (account.status === 'active' && Number.isSafeInteger(account.mfaVerifiedAt) && account.mfaVerifiedAt >= 0) {
    items.push({ key: 'ACCOUNT', state: 'ok' })
  } else {
    items.push({ key: 'ACCOUNT', state: 'conflict',
      reason: account.status === 'active' ? 'cuenta activa sin mfaVerifiedAt válido' : 'cuenta ' + String(account.status) })
  }
  let modelGrants: ProvisionReport['modelGrants'] = 'absent'
  for (const scopeId of PILOT_SCOPE_IDS) {
    const scope = await get(db, tableName, scopePartition(userId, scopeId), 'SCOPE')
    const key = `SCOPE#${scopeId}` as const
    if (!scope) items.push({ key, state: 'missing' })
    else if (sameActions(scope.actions)) items.push({ key, state: 'ok' })
    else items.push({ key, state: 'conflict', reason: 'acciones distintas de las esperadas' })
    const grants = await db.send(new QueryCommand({ TableName: tableName, ConsistentRead: true, Limit: 1,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :model)',
      ExpressionAttributeValues: { ':pk': scopePartition(userId, scopeId), ':model': 'MODEL' } }))
    if (grants.Items?.length) modelGrants = 'present'
  }
  const status = items.some(i => i.state === 'conflict') ? 'conflict'
    : items.every(i => i.state === 'ok') ? 'complete' : 'partial'
  return { status, userId, items, modelGrants }
}

type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>

/**
 * Creates the missing rows in one transaction and returns the verified final state. Safe to repeat
 * and to run concurrently: every row is created only if absent, and a lost race is re-read and
 * re-planned. `mfaVerifiedAt` applies only to a new account.
 */
export async function applyProvision(db: DynamoDBDocumentClient, tableName: string, subject: string,
  options: { readonly mfaVerifiedAt: number; readonly newUserId?: () => string }): Promise<ProvisionReport & { written: ItemKey[] }> {
  assertSubject(subject)
  const { mfaVerifiedAt, newUserId = randomUUID } = options
  if (!Number.isSafeInteger(mfaVerifiedAt) || mfaVerifiedAt < 0) throw new AdminError('mfaVerifiedAt inválido')
  for (let attempt = 0; attempt < 3; attempt++) {
    const report = await readProvision(db, tableName, subject)
    const conflicts = report.items.filter(i => i.state === 'conflict')
    if (conflicts.length) {
      throw new AdminError('Estado en conflicto, no se escribió nada: ' + conflicts.map(c => `${c.key} (${c.reason})`).join(', '))
    }
    const missing = report.items.filter(i => i.state === 'missing').map(i => i.key)
    if (!missing.length) return { ...report, written: [] }
    const userId = report.userId ?? newUserId()
    const create = (pk: string, sk: string, fields: Record<string, unknown>) => ({
      Put: { TableName: tableName, Item: { pk, sk, ...fields }, ConditionExpression: 'attribute_not_exists(pk)' },
    })
    const writes: Writes = []
    // A reused mapping must still point to the same user when the transaction commits.
    if (report.userId) {
      writes.push({ ConditionCheck: { TableName: tableName, Key: { pk: 'SUBJECT', sk: subject },
        ConditionExpression: 'userId = :userId', ExpressionAttributeValues: { ':userId': userId } } })
    }
    for (const key of missing) {
      if (key === 'SUBJECT') writes.push(create('SUBJECT', subject, { userId }))
      else if (key === 'ACCOUNT') writes.push(create(userPk(userId), 'ACCOUNT', { status: 'active', mfaVerifiedAt }))
      else writes.push(create(scopePartition(userId, key.slice('SCOPE#'.length)), 'SCOPE', { actions: new Set(PILOT_SCOPE_ACTIONS) }))
    }
    try {
      await db.send(new TransactWriteCommand({ TransactItems: writes }))
    } catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.some(
        r => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict')) continue
      throw error
    }
    const final = await readProvision(db, tableName, subject)
    if (final.status !== 'complete' || final.userId !== userId) throw new AdminError('La verificación posterior no encontró el estado completo')
    return { ...final, written: missing }
  }
  throw new AdminError('Escrituras concurrentes: volvé a ejecutar el aprovisionamiento')
}

export interface AwsTarget { readonly tableName: string; readonly region: string; readonly account: string }

/** Confirms the account and region from the table ARN before any data access. */
export async function confirmTable(client: DynamoDBClient, target: AwsTarget) {
  const { Table } = await client.send(new DescribeTableCommand({ TableName: target.tableName }))
  const parts = Table?.TableArn?.split(':') ?? []
  if (parts[0] !== 'arn' || parts[2] !== 'dynamodb' || parts[5] !== 'table/' + target.tableName) {
    throw new AdminError('ARN de tabla inesperado')
  }
  if (parts[4] !== target.account) throw new AdminError('La tabla pertenece a otra cuenta que la esperada')
  if (parts[3] !== target.region) throw new AdminError('La tabla está en otra región que la indicada')
  if (Table?.TableStatus !== 'ACTIVE') throw new AdminError('La tabla no está activa')
}
