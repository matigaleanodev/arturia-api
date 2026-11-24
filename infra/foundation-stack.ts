// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Aws, BootstraplessSynthesizer, CfnOutput, Fn, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib'
import { CfnManagedPolicy, CfnRole } from 'aws-cdk-lib/aws-iam'
import { CfnBucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import { addBudget } from './cost-controls.ts'
import {
  ARTIFACT_BUCKET, BOUNDARY_NAME, OPERATOR_POLICY_NAME, ROLE_NAMES, STACKS, operatorManagedPolicy, policy, rolePolicies, roleTrust,
  type Target,
} from './delivery.ts'

/**
 * Privileged foundation: the artifact bucket, the pilot's predefined roles, the operator's managed
 * policy and the project's monthly budget. It has no assets and needs no CDK bootstrap. An administrator
 * deploys it after creating the external boundary, which this stack references but cannot edit. The
 * budget lives here so that destroying the pilot keeps cost monitoring. The template is account-agnostic.
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

    const boundary = Fn.sub(`arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${BOUNDARY_NAME}`)
    const policies = rolePolicies(deployed)
    for (const name of ROLE_NAMES) {
      const role = new CfnRole(this, `${name}Role`, {
        roleName: `${STACKS.pilot}-${name}`,
        permissionsBoundary: boundary,
        assumeRolePolicyDocument: roleTrust(name),
        policies: [{ policyName: 'pilot', policyDocument: policy(policies[name]) }],
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
