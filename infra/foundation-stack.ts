// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Aws, BootstraplessSynthesizer, CfnOutput, Fn, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib'
import { CfnTable } from 'aws-cdk-lib/aws-dynamodb'
import { CfnManagedPolicy, CfnRole } from 'aws-cdk-lib/aws-iam'
import { CfnBucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import { TABLE_LIMITS, addBudget } from './cost-controls.ts'
import {
  ARTIFACT_BUCKET, BOUNDARY_NAME, HOSTING_POLICY_NAME, NAMES, OPERATOR_POLICY_NAME, ROLE_NAMES, STACKS, cloudformationPolicies,
  operatorManagedPolicy, policy, rolePolicies, roleTrust, type Target,
} from './delivery.ts'

/**
 * Privileged foundation: the artifact bucket, the retained AI consumption ledger table, the pilot's predefined roles, the hosting managed policy
 * of the CloudFormation role, the operator's managed policy and the project's monthly budget. It has no
 * assets and needs no CDK bootstrap. An administrator deploys it after creating the external boundary,
 * which this stack references but cannot edit. The budget lives here so that destroying the pilot keeps
 * cost monitoring. The template is account-agnostic.
 */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      stackName: STACKS.foundation,
      description: 'Arturia: pilot artifact bucket, predefined roles, operator policy and budget (no application resources)',
      synthesizer: new BootstraplessSynthesizer(),
    })
    const deployed: Target = { partition: Aws.PARTITION, account: Aws.ACCOUNT_ID, region: Aws.REGION }
    Tags.of(this).add('Project', 'arturia')
    Tags.of(this).add('Environment', 'foundation')

    const bucket = new CfnBucket(this, 'Artifacts', {
      bucketName: Fn.sub(ARTIFACT_BUCKET),
      publicAccessBlockConfiguration: {
        blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true,
      },
      ownershipControls: { rules: [{ objectOwnership: 'BucketOwnerEnforced' }] },
      bucketEncryption: { serverSideEncryptionConfiguration: [{ serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }] },
      versioningConfiguration: { status: 'Enabled' },
      lifecycleConfiguration: { rules: [{
        id: 'BoundPreviousVersions', status: 'Enabled',
        noncurrentVersionExpiration: { noncurrentDays: 30 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
      }] },
    })
    bucket.applyRemovalPolicy(RemovalPolicy.RETAIN)
    new CfnBucketPolicy(this, 'ArtifactsPolicy', {
      bucket: bucket.ref,
      policyDocument: policy([{
        Effect: 'Deny', Principal: '*', Action: 's3:*',
        Resource: [bucket.attrArn, `${bucket.attrArn}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }]),
    })

    // Holds only monthly consumption counters, attempts and settlement audits (amounts and opaque IDs, no content).
    // Retained and under point-in-time recovery so that destroying or recreating the pilot cannot reset the budget.
    const ledger = new CfnTable(this, 'Ledger', {
      tableName: NAMES.ledgerTable,
      billingMode: 'PAY_PER_REQUEST',
      onDemandThroughput: { maxReadRequestUnits: TABLE_LIMITS.maxReadRequestUnits, maxWriteRequestUnits: TABLE_LIMITS.maxWriteRequestUnits },
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }, { attributeName: 'sk', attributeType: 'S' }],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }, { attributeName: 'sk', keyType: 'RANGE' }],
      deletionProtectionEnabled: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    })
    ledger.applyRemovalPolicy(RemovalPolicy.RETAIN)
    new CfnOutput(this, 'LedgerTable', { value: ledger.ref })

    const boundary = Fn.sub(`arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${BOUNDARY_NAME}`)
    const policies = rolePolicies(deployed)
    const cfn = cloudformationPolicies(deployed)
    // Attached from the CloudFormation role only: the policy itself names no principal.
    const hosting = new CfnManagedPolicy(this, 'CloudFormationHostingPolicy', {
      managedPolicyName: HOSTING_POLICY_NAME,
      description: 'Arturia pilot: web hosting and observability permissions of the CloudFormation role',
      policyDocument: policy(cfn.hosting),
    })
    for (const name of ROLE_NAMES) {
      const role = new CfnRole(this, `${name}Role`, {
        roleName: `${STACKS.pilot}-${name}`,
        permissionsBoundary: boundary,
        assumeRolePolicyDocument: roleTrust(name),
        policies: [{ policyName: 'pilot', policyDocument: policy(name === 'cloudformation' ? cfn.inline : policies[name]) }],
        ...(name === 'cloudformation' ? { managedPolicyArns: [hosting.ref] } : {}),
      })
      new CfnOutput(this, `${name}RoleArn`, { value: role.attrArn })
    }
    // Referenced by name from the Architect permission set; attaching it is an administrative step (A1).
    const operator = new CfnManagedPolicy(this, 'OperatorPolicy', {
      managedPolicyName: OPERATOR_POLICY_NAME,
      description: 'Arturia pilot: deployment with the CloudFormation role and runbook operations on Arturia resources',
      policyDocument: operatorManagedPolicy(deployed),
    })
    new CfnOutput(this, 'OperatorPolicyArn', { value: operator.ref })
    addBudget(this)
    new CfnOutput(this, 'ArtifactBucket', { value: bucket.ref })
  }
}
