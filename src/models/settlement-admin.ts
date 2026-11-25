// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// Administrative reconciliation of uncertain model reservations. A reservation stays `reserved` after a
// timeout, a cut stream, an unrecorded result or an expired lease, because the provider may have processed
// and billed it. Nothing here releases one without evidence: the operator loads the provider's exported
// invoice or usage, the plan matches it to attempts of one UTC month, one user and the requested scopes,
// and only a matched attempt is settled, through the same idempotent settlement the worker uses. The
// evidence and the audit rows carry amounts and opaque references only, never content.

import { QueryCommand } from '@aws-sdk/lib-dynamodb'
import { AdminError } from '../admin/provision.js'
import type { ChatStore } from '../chat/turns.store.js'
import { TIMING } from '../config/timing.js'
import { ModelBudget } from './budget.js'

export const SETTLEMENT_SOURCE = 'operator-cli'
/** Longer than the time in which a worker can still own a reservation (lease and redelivery have resolved by then). */
export const MIN_UNCERTAIN_AGE_SECONDS = TIMING.turnVisibilitySeconds
export const MAX_EVIDENCE_ENTRIES = 1000
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REFERENCE = /^[A-Za-z0-9._:-]{1,64}$/

export interface EvidenceEntry { readonly attemptId: string; readonly costMicros: number; readonly reference: string }
export interface Evidence { readonly month: string; readonly entries: readonly EvidenceEntry[] }

const invalid = (reason: string): never => { throw new AdminError('Evidencia inválida: ' + reason) }
const exactKeys = (value: object, keys: readonly string[], where: string) => {
  const actual = Object.keys(value).sort().join()
  if (actual !== [...keys].sort().join()) invalid(`${where} debe tener exactamente ${keys.join(', ')}`)
}

/** Strict: unknown keys, free text, duplicates and non-integer amounts are rejected rather than ignored. */
export function parseEvidence(input: unknown): Evidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('se esperaba un objeto')
  exactKeys(input, ['month', 'entries'], 'el archivo')
  const { month, entries } = input as { month: unknown; entries: unknown }
  if (typeof month !== 'string' || !MONTH.test(month)) invalid('month debe ser YYYY-MM')
  if (!Array.isArray(entries)) return invalid('entries debe ser una lista')
  if (entries.length > MAX_EVIDENCE_ENTRIES) invalid(`máximo ${MAX_EVIDENCE_ENTRIES} entradas`)
  const seen = new Set<string>()
  const parsed = entries.map((entry: unknown, i): EvidenceEntry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid(`entrada ${i} inválida`)
    exactKeys(entry, ['attemptId', 'costMicros', 'reference'], `la entrada ${i}`)
    const { attemptId, costMicros, reference } = entry as Record<string, unknown>
    if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) return invalid(`attemptId de la entrada ${i}`)
    if (typeof costMicros !== 'number' || !Number.isSafeInteger(costMicros) || costMicros < 0) return invalid(`costMicros de la entrada ${i}`)
    if (typeof reference !== 'string' || !REFERENCE.test(reference)) return invalid(`reference de la entrada ${i}`)
    if (seen.has(attemptId)) return invalid(`attemptId repetido en la entrada ${i}`)
    seen.add(attemptId)
    return { attemptId, costMicros, reference }
  })
  return { month: month as string, entries: parsed }
}

export interface ListOptions {
  readonly userId?: string
  readonly scopeIds?: readonly string[]
  /** Reserved for less than this are still possibly in flight. Defaults to `MIN_UNCERTAIN_AGE_SECONDS`. */
  readonly minAgeSeconds?: number
}
export interface UncertainReservation {
  readonly attemptId: string
  readonly scopeId: string
  readonly provider: string
  readonly model?: string
  readonly turnId?: string
  readonly maxCost: number
  readonly month: string
  readonly reservedAt: number
  readonly ageSeconds: number
}

/** `reserved` attempts of one UTC month, from the ledger partition: a Query, never a scan. */
export async function listUncertainReservations(store: ChatStore, month: string, options: ListOptions = {}): Promise<UncertainReservation[]> {
  if (!MONTH.test(month)) throw new AdminError('El mes debe ser YYYY-MM')
  const minAge = options.minAgeSeconds ?? MIN_UNCERTAIN_AGE_SECONDS
  const now = store.now().getTime()
  const found: UncertainReservation[] = []
  let cursor: Record<string, unknown> | undefined
  do {
    const page = await store.db.send(new QueryCommand({
      TableName: store.tableName, ConsistentRead: true, ExclusiveStartKey: cursor,
      KeyConditionExpression: options.userId ? 'pk = :pk AND begins_with(sk, :user)' : 'pk = :pk',
      FilterExpression: '#state = :reserved', ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':pk': 'MODEL-LEDGER#' + month, ':reserved': 'reserved',
        ...(options.userId && { ':user': options.userId + '#' }) },
    }))
    for (const row of page.Items ?? []) {
      if (options.scopeIds && !options.scopeIds.includes(row.scopeId)) continue
      const reservedAt: number = row.reservedAt ?? 0
      const ageSeconds = Math.floor((now - reservedAt) / 1000)
      if (ageSeconds < minAge) continue
      found.push({ attemptId: row.attemptId, scopeId: row.scopeId, provider: row.provider,
        ...(row.model && { model: row.model }), ...(row.turnId && { turnId: row.turnId }),
        maxCost: row.maxCost, month, reservedAt, ageSeconds })
    }
    cursor = page.LastEvaluatedKey
  } while (cursor)
  return found.sort((a, b) => a.reservedAt - b.reservedAt || a.attemptId.localeCompare(b.attemptId))
}

export type Rejection = 'unknown-attempt' | 'month-mismatch' | 'too-recent' | 'conflicting-settlement'
export interface SettleItem {
  readonly attemptId: string
  readonly costMicros: number
  readonly maxCost: number
  /** Positive: held money returned to the budget. Negative: the invoice exceeded the reservation. */
  readonly releasedMicros: number
  readonly reference: string
}
export interface SettlementPlan {
  readonly month: string
  readonly settle: readonly SettleItem[]
  readonly alreadySettled: readonly string[]
  /** Uncertain reservations of the month without evidence: they keep their reservation. */
  readonly kept: readonly string[]
  readonly rejected: ReadonlyArray<{ readonly attemptId: string; readonly reason: Rejection }>
}

/** Read-only. An attempt of another user, another scope filter or an unknown ID is reported identically. */
export async function planSettlement(store: ChatStore, evidence: Evidence, options: ListOptions = {}): Promise<SettlementPlan> {
  const budget = new ModelBudget(store, {})
  const minAge = options.minAgeSeconds ?? MIN_UNCERTAIN_AGE_SECONDS
  const owned = await listUncertainReservations(store, evidence.month, { ...options, minAgeSeconds: 0 })
  const reserved = new Map(owned.map(r => [r.attemptId, r]))
  const settle: SettleItem[] = []
  const alreadySettled: string[] = []
  const rejected: Array<{ attemptId: string; reason: Rejection }> = []
  for (const { attemptId, costMicros, reference } of evidence.entries) {
    const open = reserved.get(attemptId)
    if (open) {
      if (open.ageSeconds < minAge) rejected.push({ attemptId, reason: 'too-recent' })
      else settle.push({ attemptId, costMicros, maxCost: open.maxCost, releasedMicros: open.maxCost - costMicros, reference })
      continue
    }
    const row = await budget.getAttempt(attemptId)
    const visible = row && (!options.userId || row.userId === options.userId) && (!options.scopeIds || options.scopeIds.includes(row.scopeId))
    if (!visible) rejected.push({ attemptId, reason: 'unknown-attempt' })
    else if (row.month !== evidence.month) rejected.push({ attemptId, reason: 'month-mismatch' })
    else if (row.state === 'settled' && row.costMicros === costMicros) alreadySettled.push(attemptId)
    else rejected.push({ attemptId, reason: 'conflicting-settlement' })
  }
  const covered = new Set(evidence.entries.map(e => e.attemptId))
  const kept = owned.filter(r => r.ageSeconds >= minAge && !covered.has(r.attemptId)).map(r => r.attemptId).sort()
  return { month: evidence.month, settle, alreadySettled, kept, rejected }
}

/** Writes only what the plan matched. Repeating it is harmless: a settled attempt with the same cost is a no-op. */
export async function applySettlement(store: ChatStore, plan: SettlementPlan) {
  const budget = new ModelBudget(store, {})
  let settled = 0
  for (const item of plan.settle) {
    await budget.settleAttempt(item.attemptId, { kind: 'invoice', costMicros: item.costMicros },
      { reference: item.reference, source: SETTLEMENT_SOURCE })
    settled++
  }
  return { settled, alreadySettled: plan.alreadySettled.length }
}
