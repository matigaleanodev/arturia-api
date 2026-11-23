// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { Aws, BootstraplessSynthesizer, CfnOutput, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { CfnRole } from 'aws-cdk-lib/aws-iam'
import { CfnBucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'
import {
  ARTIFACT_BUCKET, BOUNDARY_NAME, ROLE_NAMES, STACKS, policy, rolePolicies, roleTrust, type Target,
} from './delivery.ts'

/**
 * Privileged foundation: the artifact bucket and the pilot's predefined roles. It has no assets and
 * needs no CDK bootstrap. An administrator deploys it after creating the external boundary, which
 * this stack references but cannot edit. The template is account-agnostic.
 */
export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      stackName: STACKS.foundation,
      description: 'Arturia: pilot artifact bucket and predefined roles (no application resources)',
      synthesizer: new BootstraplessSynthesizer(),
    })
    const deployed: Target = { partition: Aws.PARTITION, account: Aws.ACCOUNT_ID, region: Aws.REGION }

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
    new CfnOutput(this, 'ArtifactBucket', { value: bucket.ref })
  }
}
