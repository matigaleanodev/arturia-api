// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { CfnParameter, type Stack } from 'aws-cdk-lib'
import { CfnBudget } from 'aws-cdk-lib/aws-budgets'
import { BUDGET_NAME } from './delivery.ts'

/**
 * Monthly AWS budget of the project, owned by the foundation so that destroying the pilot keeps cost
 * monitoring. Alerts only: a budget never stops spending, and AWS updates billing data with a delay of
 * hours. There are no budget actions, so no service role can change permissions or resources.
 */
export const BUDGET = {
  limitUsd: 10,
  actualAlertsUsd: [5, 8],
  forecastAlertUsd: 10,
  /** Cost allocation tag applied by the App. Billing must activate it before the budget sees any cost. */
  tag: { key: 'Project', value: 'arturia' },
} as const

const EMAIL_PATTERN = '[^@\\s]+@[^@\\s]+\\.[^@\\s]+'

/** Email address supplied at deployment time; templates and repository never contain it. */
export function alertEmailParameter(stack: Stack, id: string) {
  return new CfnParameter(stack, id, {
    type: 'String', allowedPattern: EMAIL_PATTERN, minLength: 6, maxLength: 254,
    description: 'Email that receives Arturia alerts (supplied at deploy time, never versioned)',
  })
}

export function addBudget(stack: Stack) {
  const email = alertEmailParameter(stack, 'BudgetAlertEmail')
  const subscribers = [{ subscriptionType: 'EMAIL', address: email.valueAsString }]
  const notification = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
    notification: { notificationType, comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'ABSOLUTE_VALUE' },
    subscribers,
  })
  return new CfnBudget(stack, 'MonthlyBudget', {
    budget: {
      budgetName: BUDGET_NAME, budgetType: 'COST', timeUnit: 'MONTHLY',
      budgetLimit: { amount: BUDGET.limitUsd, unit: 'USD' },
      costFilters: { TagKeyValue: [`user:${BUDGET.tag.key}$${BUDGET.tag.value}`] },
      // Credits and refunds would hide real usage on an account with promotional credits.
      costTypes: { includeCredit: false, includeRefund: false },
    },
    notificationsWithSubscribers: [
      ...BUDGET.actualAlertsUsd.map(usd => notification('ACTUAL', usd)),
      notification('FORECASTED', BUDGET.forecastAlertUsd),
    ],
  })
}

/**
 * Maximum on-demand throughput of the chat table, in request units per second. A runaway client or
 * worker loop is throttled instead of billed without bound; DynamoDB may briefly exceed the cap with
 * burst capacity. Expected peak, single pilot user with 4 open tabs:
 * - Reads: each SSE snapshot is a transactional read of 4 small items (2 RRU each): 8 RRU. While blocks
 *   flow at about 1 per second a connection takes a page (snapshot, strongly consistent query, snapshot:
 *   17 RRU) plus one or two empty polls (8 RRU each): about 33 RRU/s. Four connections: about 130 RRU/s.
 *   HTTP reads add about 20 RRU/s at the stage limit. Total about 150.
 * - Writes: an accepted turn is one transaction of about 6 items (2 WRU each): 12 WRU, with a burst of 5
 *   turns: 60 WRU/s. Two concurrent workers write one block per second in a two-item transaction: about
 *   8 WRU/s plus lease and terminal writes. Total about 70.
 * The caps keep at least twice that headroom; 13.10 measures ConsumedRead/WriteCapacityUnits to recalibrate.
 * Beyond one user the SSE throttle admits up to 33 streams, which the read cap would throttle: acceptable
 * for the single-user pilot and a deliberate bound on cost.
 */
export interface TableLimits {
  readonly expectedPeakReadUnits: number
  readonly expectedPeakWriteUnits: number
  readonly maxReadRequestUnits: number
  readonly maxWriteRequestUnits: number
}

export function checkTableLimits(t: TableLimits): TableLimits {
  const broken: string[] = []
  const rule = (ok: boolean, message: string) => { if (!ok) broken.push(message) }
  for (const [name, value] of Object.entries(t)) rule(Number.isSafeInteger(value) && value >= 1, `${name} must be an integer of at least 1`)
  rule(t.maxReadRequestUnits >= 2 * t.expectedPeakReadUnits, 'read cap needs twice the expected peak as headroom')
  rule(t.maxWriteRequestUnits >= 2 * t.expectedPeakWriteUnits, 'write cap needs twice the expected peak as headroom')
  if (broken.length) throw new RangeError('Invalid table limits: ' + broken.join('; '))
  return t
}

export const TABLE_LIMITS: TableLimits = checkTableLimits({
  expectedPeakReadUnits: 150, expectedPeakWriteUnits: 70, maxReadRequestUnits: 400, maxWriteRequestUnits: 150,
})
