// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { expect, test } from 'vitest'
import { PROVIDER_SECRET_NAME, isProviderSecretArn } from '../src/secrets/provider-secret.ts'
import { NAMES, boundaryPolicy, operatorPolicy, rolePolicies, type Statement, type Target } from './delivery.ts'

const target: Target = { partition: 'aws', account: '111111111111', region: 'us-east-1' }
const secretStatements = (list: readonly Statement[]) => list.filter(s => s.Action.some(action => action.startsWith('secretsmanager:')))
const pattern = `arn:aws:secretsmanager:us-east-1:111111111111:secret:${PROVIDER_SECRET_NAME}-??????`

test('provider_secret_name_is_the_same_in_runtime_and_infrastructure', () => {
  expect(NAMES.providerSecret).toBe(PROVIDER_SECRET_NAME)
})

test('secret_grant_limited_to_one_arn', () => {
  // Only the worker reads the value; the exact name plus the six random characters Secrets Manager appends.
  const policies = rolePolicies(target)
  expect(secretStatements(policies.worker)).toEqual([
    { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [pattern] }])
  for (const [role, statements] of Object.entries(policies)) {
    if (role !== 'worker') expect(secretStatements(statements), role).toEqual([])
  }
  // The boundary caps the worker with the same single secret, with no wildcard beyond the suffix.
  const boundary = secretStatements((boundaryPolicy(target).Statement as Statement[]))
  expect(boundary).toEqual([{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [pattern] }])
  // The operator verifies that the secret exists, never reads its value.
  const operator = secretStatements((operatorPolicy(target).Statement as Statement[]))
  expect(operator).toEqual([{ Effect: 'Allow', Action: ['secretsmanager:DescribeSecret'], Resource: [pattern] }])
  // A real ARN of the secret is matched by the pattern, and a similarly named one is not.
  const matches = (arn: string) => new RegExp('^' + pattern.replace(/\?/g, '.') + '$').test(arn)
  expect(matches('arn:aws:secretsmanager:us-east-1:111111111111:secret:arturia-pilot/providers-AbCdEf')).toBe(true)
  expect(matches('arn:aws:secretsmanager:us-east-1:111111111111:secret:arturia-pilot/providers-other-AbCdEf')).toBe(false)
  expect(matches('arn:aws:secretsmanager:us-east-1:111111111111:secret:arturia-pilot/providers2-AbCdEf')).toBe(false)
  expect(isProviderSecretArn('arn:aws:secretsmanager:us-east-1:111111111111:secret:arturia-pilot/providers-AbCdEf')).toBe(true)
})
