// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { App, Stack, aws_lambda as lambda } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { expect, test } from 'vitest'
import { addOutbox } from './outbox.js'

test('outbox_stream_filters_keys_only_with_bounded_retry_and_dead_letters', () => {
  const stack = new Stack(new App(), 'Fixture')
  const relay = new lambda.Function(stack, 'FixtureRelay', { runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler', code: lambda.Code.fromInline('exports.handler=async()=>{}') })
  addOutbox(stack, relay)
  const template = Template.fromStack(stack)
  template.hasResourceProperties('AWS::DynamoDB::Table', { StreamSpecification: { StreamViewType: 'KEYS_ONLY' } })
  const [source] = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))
  expect(source?.Properties).toMatchObject({ StartingPosition: 'TRIM_HORIZON',
    MaximumRetryAttempts: 5, FunctionResponseTypes: ['ReportBatchItemFailures'],
    DestinationConfig: { OnFailure: { Destination: expect.anything() } } })
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement)
  const dataActions = ['dynamodb:GetItem', 'dynamodb:UpdateItem']
  const dataGrants = statements.filter(statement => [statement.Action].flat().some(action => dataActions.includes(action)))
  expect(dataGrants).toHaveLength(1)
  expect(dataGrants[0]).toMatchObject({ Action: dataActions, Effect: 'Allow', Condition: {
    'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': 'OUTBOX#*' },
    Null: { 'dynamodb:LeadingKeys': 'false' },
  } })
  expect(JSON.parse(source.Properties.FilterCriteria.Filters[0].Pattern)).toEqual({
    dynamodb: { Keys: { pk: { S: [{ prefix: 'OUTBOX#' }] }, sk: { S: [{ prefix: 'OUTBOX#' }] } } },
  })
  template.hasResourceProperties('AWS::SQS::Queue', { FifoQueue: true, RedrivePolicy: {
    deadLetterTargetArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] }, maxReceiveCount: 5,
  } })
})
