// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { setTimeout as delay } from 'node:timers/promises'
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb'
import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type { ChatStore } from '../chat/turns.store.js'
import { ModelPolicyDenied } from './provider.js'

const MILLION = 1_000_000
const MONTHLY_CAP = 10 * MILLION
const uint = (n: number) => Number.isSafeInteger(n) && n >= 0
export interface Tariff {
  readonly verifiedAt: number
  readonly expiresAt: number
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly toolCall: number
}
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly toolTokens: number
  readonly toolCalls: number
}
type Receipt = { kind: 'unknown' } | { kind: 'invoice'; costMicros: number } | { kind: 'reported'; usage: Usage }
type Audit = { model: string; operation: 'chat' | 'tool' | 'extraction' | 'automation'; tariff: Tariff }
type Writes = NonNullable<TransactWriteCommandInput['TransactItems']>
const attemptKey = (id: string) => ({ pk: 'MODEL-ATTEMPT#' + id, sk: 'RECEIPT' })
const counterKeys = (month: string, provider: string) => ['TOTAL', 'PROVIDER#' + provider].map(sk => ({
  pk: 'MODEL-BUDGET#' + month, sk,
}))

export function tariffSnapshot(t: Tariff | undefined, time: number): Tariff {
  if (!t || ![t.inputPerMillion, t.outputPerMillion, t.toolCall, t.verifiedAt, t.expiresAt, time].every(uint) ||
      time < t.verifiedAt || time >= t.expiresAt) throw new ModelPolicyDenied('Unverified model tariff')
  const { verifiedAt, expiresAt, inputPerMillion, outputPerMillion, toolCall } = t
  return { verifiedAt, expiresAt, inputPerMillion, outputPerMillion, toolCall }
}

function metered(u: Usage): Usage {
  const { inputTokens, outputTokens, reasoningTokens, toolTokens, toolCalls } = u
  const fields = { inputTokens, outputTokens, reasoningTokens, toolTokens, toolCalls }
  if (!Object.values(fields).every(uint)) throw new RangeError('Invalid billable usage')
  return fields
}

export function costMicros(tariff: Tariff, usage: Usage) {
  const u = metered(usage)
  const { inputPerMillion, outputPerMillion, toolCall } = tariff
  if (![inputPerMillion, outputPerMillion, toolCall].every(uint)) throw new RangeError('Invalid model price')
  const out = BigInt(u.outputTokens) + BigInt(u.reasoningTokens) + BigInt(u.toolTokens)
  const tokenCost = BigInt(u.inputTokens) * BigInt(inputPerMillion) + out * BigInt(outputPerMillion)
  const cost = Number((tokenCost + 999_999n) / 1_000_000n + BigInt(u.toolCalls) * BigInt(toolCall))
  if (!uint(cost)) throw new RangeError('Cost exceeds supported precision')
  return cost
}

export class ModelBudget {
  constructor(private readonly store: Pick<ChatStore, 'tableName' | 'read' | 'now' | 'db'>,
    private readonly caps: Readonly<Record<string, number>>) {}

  getAttempt(attemptId: string) {
    const { pk, sk } = attemptKey(attemptId)
    return this.store.read(pk, sk)
  }

  // Only storage conflicts are retried. This transaction never calls a model.
  private async write(items: Writes) {
    for (let retry = 0; ; retry++) {
      try {
        await this.store.db.send(new TransactWriteCommand({ TransactItems: items }))
        return true
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error
        const reasons = error.CancellationReasons ?? []
        if (reasons.some(r => r.Code === 'ConditionalCheckFailed')) return false
        if (retry >= 7 || !reasons.some(r => r.Code === 'TransactionConflict')) throw error
        await delay(5 * 2 ** retry)
      }
    }
  }

  // Each successful reservation is a single-use permission; a duplicate never authorizes another send.
  async reserveAttempt(attemptId: string, userId: string, scopeId: string, provider: string, maxCost: number, audit?: Audit) {
    const now = this.store.now()
    const month = now.toISOString().slice(0, 7)
    const cap = Object.hasOwn(this.caps, provider) ? this.caps[provider] : NaN
    if (!attemptId || !userId || !scopeId || !provider || !uint(maxCost) || !uint(cap) ||
        maxCost > Math.min(MONTHLY_CAP, cap)) return { allowed: false } as const
    const TableName = this.store.tableName
    const limits = [MONTHLY_CAP, cap]
    const allowed = await this.write([
      { Put: { TableName, ConditionExpression: 'attribute_not_exists(pk)', Item: {
        ...attemptKey(attemptId), userId, scopeId, provider, month, maxCost, state: 'reserved',
        ...(audit && { model: audit.model, operation: audit.operation, tariff: tariffSnapshot(audit.tariff, now.getTime()) }),
      } } },
      ...counterKeys(month, provider).map((Key, i) => ({ Update: { TableName, Key,
        UpdateExpression: 'ADD allocated :amount',
        ConditionExpression: 'attribute_not_exists(allocated) OR allocated <= :remaining',
        ExpressionAttributeValues: { ':amount': maxCost, ':remaining': limits[i] - maxCost },
      } })),
    ])
    return { allowed, month }
  }

  async settleAttempt(attemptId: string, receipt: Receipt) {
    const row = await this.getAttempt(attemptId)
    if (!row) throw new Error('Unknown model attempt')
    if (receipt.kind === 'unknown') return
    const usage = receipt.kind === 'reported' ? metered(receipt.usage) : undefined
    const cost = receipt.kind === 'invoice' ? receipt.costMicros : costMicros(row.tariff, usage!)
    if (!uint(cost)) throw new RangeError('Invalid model charge')
    const matches = (item: typeof row) => item.state === 'settled' && item.costMicros === cost &&
      (usage === undefined || (item.usage && Object.entries(usage).every(([k, v]) => item.usage[k] === v)))
    if (matches(row)) return
    if (row.state !== 'reserved') throw new Error('Conflicting model settlement')
    const TableName = this.store.tableName
    const won = await this.write([
      { Update: { TableName, Key: attemptKey(attemptId), ConditionExpression: '#s = :reserved',
        UpdateExpression: 'SET #s = :settled, costMicros = :cost' + (usage ? ', #u = :usage' : ''),
        ExpressionAttributeNames: { '#s': 'state', ...(usage && { '#u': 'usage' }) },
        ExpressionAttributeValues: { ':reserved': 'reserved', ':settled': 'settled', ':cost': cost, ...(usage && { ':usage': usage }) },
      } },
      ...counterKeys(row.month, row.provider).map(Key => ({ Update: { TableName, Key,
        ConditionExpression: 'attribute_exists(allocated)', UpdateExpression: 'ADD allocated :delta',
        ExpressionAttributeValues: { ':delta': cost - row.maxCost },
      } })),
    ])
    if (!won && !matches((await this.getAttempt(attemptId))!)) throw new Error('Conflicting model settlement')
  }
}
