// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

// The AI consumption ledger is a retained table of the foundation: destroying the pilot stack must not
// reset the monthly budget, and only the worker and the operator can reach it, item by item.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, test } from 'vitest'
import { WORKER_TABLE_ACTIONS } from './worker.ts'
import { TABLE_LIMITS } from './cost-controls.ts'
import { NAMES, SYNTHETIC_ACCOUNT, boundaryPolicy, operatorManagedPolicy, rolePolicies, type Statement, type Target } from './delivery.ts'
import { FoundationStack } from './foundation-stack.ts'
import { WEB_FIXTURE_DIR, createPilotStack, type PilotTarget } from './pilot.ts'

const tmp: string[] = []
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'arturia-ledger-')); tmp.push(dir); return dir }
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })

const target: Target = { partition: 'aws', account: '111111111111', region: 'us-east-1' }
type Resource = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string }
const tables = (json: { Resources: Record<string, Resource> }) =>
  Object.values(json.Resources).filter(resource => resource.Type === 'AWS::DynamoDB::Table')
const foundation = () => new App({ outdir: tempDir(), analyticsReporting: false })
const ledgerArn = `arn:aws:dynamodb:us-east-1:111111111111:table/${NAMES.ledgerTable}`
const chatArn = `arn:aws:dynamodb:us-east-1:111111111111:table/${NAMES.table}`

describe('ledger_table_is_retained_in_the_foundation', () => {
  const json = () => Template.fromStack(new FoundationStack(foundation(), 'Foundation')).toJSON() as { Resources: Record<string, Resource> }

  test('retained, protected against deletion, point-in-time recovery, bounded throughput and no stream', () => {
    const found = tables(json())
    expect(found).toHaveLength(1)
    const [ledger] = found
    expect(ledger!.DeletionPolicy).toBe('Retain')
    expect(ledger!.UpdateReplacePolicy).toBe('Retain')
    expect(ledger!.Properties).toMatchObject({
      TableName: NAMES.ledgerTable, BillingMode: 'PAY_PER_REQUEST', DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    })
    expect(ledger!.Properties!.OnDemandThroughput).toBeDefined()
    expect(ledger!.Properties!.OnDemandThroughput.MaxWriteRequestUnits).toBeLessThanOrEqual(TABLE_LIMITS.maxWriteRequestUnits)
    expect(ledger!.Properties!.StreamSpecification).toBeUndefined()
    expect(ledger!.Properties!.TimeToLiveSpecification).toBeUndefined()
  })

  test('the pilot stack does not own it and keeps a different chat table', () => {
    const pilot: PilotTarget = { synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: 'infra/fixtures/bundles', webDistDir: WEB_FIXTURE_DIR }
    const template = Template.fromStack(createPilotStack(foundation(), pilot)).toJSON() as { Resources: Record<string, Resource> }
    const [chat] = tables(template)
    expect(tables(template)).toHaveLength(1)
    expect(chat!.Properties!.TableName).toBe(NAMES.table)
    expect(NAMES.ledgerTable).not.toBe(NAMES.table)
    // The worker learns the ledger by name only: a plain environment variable, no cross-stack reference.
    const worker = Object.values(template.Resources).find(r => r.Type === 'AWS::Lambda::Function' && r.Properties!.FunctionName === NAMES.workerFunction)!
    expect(worker.Properties!.Environment.Variables.ARTURIA_LEDGER_TABLE_NAME).toBe(NAMES.ledgerTable)
  }, 20_000)
})

describe('ledger_permissions_are_item_level_and_least_privilege', () => {
  const on = (statements: readonly Statement[], arn: string) => statements.filter(s => s.Effect === 'Allow' && s.Resource.includes(arn)).flatMap(s => [...s.Action])
  const denied = (statements: readonly Statement[], arn: string) => statements.filter(s => s.Effect === 'Deny' && s.Resource.includes(arn)).flatMap(s => [...s.Action])

  test('the worker reads and writes ledger items but never queries, scans or deletes', () => {
    const actions = on(rolePolicies(target).worker, ledgerArn)
    expect(actions.sort()).toEqual([...WORKER_TABLE_ACTIONS].sort())
    expect(actions.some(a => /Query|Scan|Delete|Batch|Stream|dynamodb:\*/.test(a))).toBe(false)
  })

  test('the http, stream and relay roles cannot reach the ledger', () => {
    const policies = rolePolicies(target)
    for (const name of ['http', 'stream', 'relay', 'publisher'] as const) {
      expect(on(policies[name] ?? [], ledgerArn), name).toEqual([])
    }
  })

  test('the operator reads, lists by Query and settles items, with no Scan, Delete or table administration', () => {
    const actions = on(operatorManagedPolicy(target).Statement as Statement[], ledgerArn)
    expect(actions.sort()).toEqual(['dynamodb:ConditionCheckItem', 'dynamodb:DescribeTable', 'dynamodb:GetItem', 'dynamodb:PutItem',
      'dynamodb:Query', 'dynamodb:UpdateItem'])
  })

  test('the operator is denied deleting items or administering the ledger table, whatever the account-wide Architect policy allows', () => {
    const managed = operatorManagedPolicy(target).Statement as Statement[]
    const actions = denied(managed, ledgerArn)
    for (const action of ['DeleteItem', 'BatchWriteItem', 'DeleteTable', 'UpdateTable', 'UpdateContinuousBackups', 'UpdateTimeToLive',
      'PutResourcePolicy', 'DeleteResourcePolicy']) expect(actions, action).toContain('dynamodb:' + action)
    // What settlement needs is never denied, and the chat table is untouched by these denials.
    for (const action of ['GetItem', 'Query', 'PutItem', 'UpdateItem', 'ConditionCheckItem', 'DescribeTable']) {
      expect(actions, action).not.toContain('dynamodb:' + action)
    }
    expect(denied(managed, chatArn)).toEqual([])
  })

  test('the cloudformation role cannot delete or alter the ledger table, and the boundary still caps its name', () => {
    const cfn = rolePolicies(target).cloudformation
    expect(on(cfn, ledgerArn)).toEqual([])
    expect(on(boundaryPolicy(target).Statement as Statement[], 'arn:aws:dynamodb:us-east-1:111111111111:table/arturia-pilot-*')).toContain('dynamodb:*')
    // The chat table keeps its own, unchanged grants.
    expect(on(rolePolicies(target).worker, chatArn)).toEqual([...WORKER_TABLE_ACTIONS])
  })
})
