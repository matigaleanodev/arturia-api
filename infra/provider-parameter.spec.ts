// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { PROVIDER_PARAMETER_PREFIX, providerParameterName } from '../src/secrets/provider-secret.ts'
import {
  NAMES, boundaryPolicy, cloudformationPolicies, operatorDenials, operatorManagedPolicy, operatorPolicy, rolePolicies, type Statement, type Target,
} from './delivery.ts'

const target: Target = { partition: 'aws', account: '111111111111', region: 'us-east-1' }
const ssm = (list: readonly Statement[]) => list.filter(s => s.Action.some(action => action.startsWith('ssm:')))
const kms = (list: readonly Statement[]) => list.filter(s => s.Action.some(action => action.startsWith('kms:')))
const parameterArn = 'arn:aws:ssm:us-east-1:111111111111:parameter/arturia/pilot/providers/openai/api-key'
const decrypt: Statement = { Effect: 'Allow', Action: ['kms:Decrypt'], Resource: ['arn:aws:kms:us-east-1:111111111111:key/*'],
  Condition: { StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com', 'kms:EncryptionContext:PARAMETER_ARN': parameterArn } } }

/** Minimal evaluator of Allow and Deny: glob `*` in resources, exact actions, no conditions. Enough to ask what a Deny covers. */
const denied = (statements: readonly Statement[], action: string, resource: string) =>
  statements.some(s => s.Effect === 'Deny' && s.Action.includes(action) &&
    s.Resource.some(pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(resource)))

test('provider_parameter_name_is_the_same_in_runtime_and_infrastructure', () => {
  expect(NAMES.providerParameterPrefix).toBe(PROVIDER_PARAMETER_PREFIX)
  expect(`arn:aws:ssm:us-east-1:111111111111:parameter${providerParameterName('openai')}`).toBe(parameterArn)
  expect(Object.keys(NAMES)).not.toContain('providerSecret')
})

test('parameter_grant_limited_to_one_arn', () => {
  // Only the worker reads the value, with the exact ARN of the OpenAI parameter and no wildcard.
  const policies = rolePolicies(target)
  expect(ssm(policies.worker)).toEqual([{ Effect: 'Allow', Action: ['ssm:GetParameter'], Resource: [parameterArn] }])
  // `aws/ssm` needs no grant in the key policy, but the permissions boundary and the role need the identity side: decrypt through SSM,
  // for this one parameter, on any key (the AWS managed key ID is not known when the template is synthesized).
  expect(kms(policies.worker)).toEqual([decrypt])
  for (const [role, statements] of Object.entries(policies)) {
    if (role !== 'worker') {
      expect(ssm(statements), role).toEqual([])
      expect(kms(statements), role).toEqual([])
    }
  }
  // The boundary caps the worker with the same single parameter and the same conditional decryption.
  const boundary = boundaryPolicy(target).Statement as Statement[]
  expect(ssm(boundary)).toEqual([{ Effect: 'Allow', Action: ['ssm:GetParameter'], Resource: [parameterArn] }])
  expect(kms(boundary)).toEqual([decrypt])
  // Another parameter of the same prefix or a similar name is not covered by the grant.
  for (const other of ['openai/api-key2', 'anthropic/api-key', 'openai']) {
    expect(parameterArn.replace('openai/api-key', other)).not.toBe(parameterArn)
  }
  expect(JSON.stringify(rolePolicies(target).worker)).not.toMatch(/ssm:Get(Parameters|ParametersByPath|ParameterHistory)|ssm:\*|kms:\*/)
})

test('the operator is granted nothing on Parameter Store or KMS', () => {
  // `ssm:DescribeParameters` (metadata, wildcard resource only) comes with the base policy of Architect and is enough to confirm
  // that the parameter exists. Adding it here would put a `*` resource in a policy that has none for data.
  const operator = operatorPolicy(target).Statement as Statement[]
  expect(ssm(operator)).toEqual([])
  expect(kms(operator)).toEqual([])
})

test('operator_cannot_read_write_or_delete_the_credential', () => {
  // The account-wide Architect policy allows `ssm:*` on any resource and `aws/ssm` decrypts for every principal of the account.
  // An explicit deny wins over any allow. It covers every route to the value.
  const managed = operatorManagedPolicy(target).Statement as Statement[]
  const parameters = '/arturia/pilot/providers/openai/api-key'
  const arn = (path: string) => `arn:aws:ssm:us-east-1:111111111111:parameter${path}`
  for (const action of ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParameterHistory', 'ssm:PutParameter', 'ssm:DeleteParameter',
    'ssm:DeleteParameters', 'ssm:LabelParameterVersion', 'ssm:UnlabelParameterVersion']) {
    expect(denied(managed, action, arn(parameters)), action).toBe(true)
    // Also the parameter of a provider that is disabled today: the prefix is protected, not only one name.
    expect(denied(managed, action, arn('/arturia/pilot/providers/anthropic/api-key')), `${action} anthropic`).toBe(true)
  }
  // GetParametersByPath is authorized against the requested path, not against each parameter it returns:
  // every ancestor path, the root included, has to be denied or a recursive read from above would return the value.
  for (const path of ['/', '/arturia', '/arturia/pilot', '/arturia/pilot/providers', '/arturia/pilot/providers/openai', parameters]) {
    expect(denied(managed, 'ssm:GetParametersByPath', arn(path)), path).toBe(true)
  }
  // Nothing outside Arturia is affected: other services keep their parameters and paths, and Arturia's own non-secret ones stay readable.
  for (const path of ['/portfolio', '/portfolio/prod/app', '/modo-playa/prod/app-properties', '/arturia-other', '/arturia/pilot/other/value']) {
    for (const action of ['ssm:GetParameter', 'ssm:GetParametersByPath', 'ssm:PutParameter']) {
      expect(denied(managed, action, arn(path)), `${action} ${path}`).toBe(false)
    }
  }
  // Decrypting the value with the key, whatever the route, is denied for the context of this prefix only.
  const kmsDeny = kms(managed)
  expect(kmsDeny).toHaveLength(1)
  expect(kmsDeny[0]).toMatchObject({ Effect: 'Deny', Action: ['kms:Decrypt'],
    Condition: { StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': arn('/arturia/pilot/providers/*') } } })
  // Not even the denials can be mistaken for an allow, and they never touch the existence check.
  expect(managed.filter(s => s.Effect === 'Deny' && s.Action.includes('ssm:DescribeParameters'))).toEqual([])
  expect((operatorDenials(target).Statement as Statement[]).filter(s => s.Action.some(a => a.startsWith('ssm:'))).every(s => s.Effect === 'Deny')).toBe(true)
})

test('no_policy_grants_or_denies_secrets_manager', () => {
  // The design moved to Parameter Store: nothing of Arturia mentions Secrets Manager, in any role, boundary, operator or CloudFormation policy.
  const everything = JSON.stringify([rolePolicies(target), boundaryPolicy(target), operatorManagedPolicy(target), cloudformationPolicies(target)])
  expect(everything).not.toMatch(/secretsmanager/i)
  expect(everything).not.toMatch(/arturia-pilot\/providers/)
})

test('the ledger protections of the operator stay in place next to the credential denials', () => {
  const managed = operatorManagedPolicy(target).Statement as Statement[]
  const ledger = 'arn:aws:dynamodb:us-east-1:111111111111:table/arturia-pilot-ledger'
  for (const action of ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteTable', 'dynamodb:UpdateTable',
    'dynamodb:UpdateContinuousBackups', 'dynamodb:UpdateTimeToLive', 'dynamodb:PutResourcePolicy', 'dynamodb:DeleteResourcePolicy',
    'dynamodb:PartiQLDelete', 'dynamodb:PartiQLUpdate', 'dynamodb:PartiQLInsert', 'dynamodb:ImportTable',
    'dynamodb:RestoreTableFromAwsBackup']) expect(denied(managed, action, ledger), action).toBe(true)
  // Settlement keeps its item-level access.
  for (const action of ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem']) expect(denied(managed, action, ledger), action).toBe(false)
})
