// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Aws, CfnOutput, CliCredentialsStackSynthesizer, Stack, aws_iam as iam, aws_lambda as lambda, type App } from 'aws-cdk-lib'
import { addChatStream } from './chat-stream.ts'
import {
  ARTIFACT_BUCKET, ARTIFACT_PREFIX, BUNDLES, NAMES, STACKS, SYNTHETIC_ACCOUNT, roleArn, type BundleName, type RoleName, type Target,
} from './delivery.ts'
import { addIdentity } from './identity.ts'
import { addOutbox } from './outbox.ts'

export interface PilotTarget {
  readonly synthetic: boolean
  readonly account: string
  readonly region: string
  readonly bundleDir: string
  readonly webDir?: string
}

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory()

/**
 * `synthetic` (default) is the non-deployable test synthesis. `pilot` is the real synthesis and
 * requires the account and region as context, the web checkout and the built Lambda bundles.
 */
export function resolvePilotTarget(context: (key: string) => unknown, env: NodeJS.ProcessEnv, bundleDir = 'dist/bundles'): PilotTarget {
  const read = (key: string) => { const value = context(key); return value === undefined || value === null ? undefined : String(value).trim() }
  const mode = read('arturia:target') ?? 'synthetic'
  if (mode === 'synthetic') {
    return { synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: 'infra/fixtures/bundles' }
  }
  if (mode !== 'pilot') throw new Error(`Invalid arturia:target "${mode}": use synthetic or pilot`)
  const account = read('arturia:account')
  if (!account || !/^\d{12}$/.test(account) || account === SYNTHETIC_ACCOUNT) {
    throw new Error('Real pilot synthesis requires -c arturia:account=<12-digit AWS account ID>')
  }
  const region = read('arturia:region')
  if (!region || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new Error('Real pilot synthesis requires -c arturia:region=<AWS region>')
  }
  const webDir = env.ARTURIA_WEB_DIR?.trim()
  if (!webDir || !isDirectory(webDir)) {
    throw new Error('Real pilot synthesis requires ARTURIA_WEB_DIR pointing to the web checkout')
  }
  for (const name of Object.keys(BUNDLES)) {
    if (!existsSync(join(bundleDir, name, 'index.cjs'))) {
      throw new Error(`Missing Lambda bundle "${name}" in ${bundleDir}: run npm run bundle first`)
    }
  }
  return { synthetic: false, account, region, bundleDir, webDir }
}

/** Pilot composition root. Code assets go to the foundation bucket; every role is imported. */
export function createPilotStack(app: App, target: PilotTarget) {
  const stack = new Stack(app, target.synthetic ? 'ArturiaPilotSynthetic' : 'ArturiaPilot', {
    stackName: target.synthetic ? STACKS.synthetic : STACKS.pilot,
    env: { account: target.account, region: target.region },
    description: 'Arturia pilot: chat API, delivery and identity',
    synthesizer: new CliCredentialsStackSynthesizer({ fileAssetsBucketName: ARTIFACT_BUCKET, bucketPrefix: ARTIFACT_PREFIX }),
  })
  // Same concrete account as the stack: with a token account CDK treats the role as foreign and
  // moves the dropped grants into resource policies. The synthesized template is never versioned.
  const deployed: Target = { partition: Aws.PARTITION, account: target.account, region: target.region }
  const role = (name: RoleName) => iam.Role.fromRoleArn(stack, `${name}Role`, roleArn(deployed, name), { mutable: false })
  const code = (name: BundleName) => lambda.Code.fromAsset(join(target.bundleDir, name))

  const { userPool, client } = addIdentity(stack)
  const relay = new lambda.Function(stack, 'OutboxRelay', {
    functionName: NAMES.relayFunction, runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler',
    code: code('relay'), role: role('relay'),
  })
  const { table } = addOutbox(stack, relay, {
    table: NAMES.table, turnQueue: NAMES.turnQueue,
    turnDeadLetters: NAMES.turnDeadLetters, relayDeadLetters: NAMES.relayDeadLetters,
  })
  addChatStream(stack, {
    table, pool: userPool, clientId: client.userPoolClientId,
    code: code('stream'), role: role('stream'), functionName: NAMES.streamFunction,
  })
  if (target.synthetic) new CfnOutput(stack, 'SyntheticSynth', { value: 'true', description: 'Test synthesis: not deployable' })
  return stack
}
