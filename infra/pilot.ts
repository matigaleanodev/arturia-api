// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Aws, CfnOutput, CliCredentialsStackSynthesizer, Duration, Lazy, Stack, Tags, aws_iam as iam, aws_lambda as lambda, type App } from 'aws-cdk-lib'
import { APIGATEWAY_AUTHORIZER_CHANGE_DEPLOYMENT_LOGICAL_ID } from 'aws-cdk-lib/cx-api'
import { addChatApi } from './chat-api.ts'
import {
  ARTIFACT_BUCKET, ARTIFACT_PREFIX, BUNDLES, NAMES, STACKS, SYNTHETIC_ACCOUNT, roleArn, type BundleName, type RoleName, type Target,
} from './delivery.ts'
import { addIdentity } from './identity.ts'
import { addAccessLogs, addAlarms, addAlertsTopic, addFunctionLogs } from './observability.ts'
import { addOutbox } from './outbox.ts'
import { addWebHosting, checkWebDist } from './web-hosting.ts'
import { addWorker } from './worker.ts'
import { ENABLED_CATALOG_MODELS, isFreshDay, isProviderSecretArn } from '../src/config/catalog-config.ts'
import type { CatalogRuntime, ProviderMode } from '../src/config/runtime.ts'
import { TIMING } from '../src/config/timing.ts'

export interface PilotTarget {
  readonly synthetic: boolean
  readonly account: string
  readonly region: string
  readonly bundleDir: string
  /** Web checkout (real synthesis only). */
  readonly webDir?: string
  /** Angular production build published by the hosting. */
  readonly webDistDir: string
  /** Optional salt that forces a new API Gateway deployment (recovery; see README). */
  readonly apiRedeploy?: string
  /** Kill switch: disables the worker's event source mapping (messages wait in the queue). */
  readonly workerPaused?: boolean
  /** Stage access logs; only once A0 confirms the account's API Gateway CloudWatch role. */
  readonly apiAccessLogs?: boolean
  /** Simulated provider of the worker; `fixture` when omitted. */
  readonly providerMode?: PilotProviderMode
  /** Only in `catalog` mode: the exact provider secret, the model and the date the official tariff was verified. */
  readonly catalog?: CatalogRuntime
}

/**
 * Modes selectable by context. `catalog` is the only billable one and is accepted only with the secret ARN, the
 * model and the tariff verification date, in the target account and region (see `catalogContext`).
 */
export const PILOT_PROVIDER_MODES = ['fixture', 'fail', 'catalog'] as const satisfies readonly ProviderMode[]
export type PilotProviderMode = typeof PILOT_PROVIDER_MODES[number]

/** Synthetic production build used by the test synthesis. */
export const WEB_FIXTURE_DIR = 'tests/fixtures/web-dist'
/** Angular production build inside the web checkout. */
export const WEB_DIST_PATH = join('dist', 'arturia', 'browser')

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory()

/**
 * `synthetic` (default) is the non-deployable test synthesis. `pilot` is the real synthesis and
 * requires the account and region as context, the web checkout and the built Lambda bundles.
 */
export function resolvePilotTarget(context: (key: string) => unknown, env: NodeJS.ProcessEnv, bundleDir = 'dist/bundles'): PilotTarget {
  const read = (key: string) => { const value = context(key); return value === undefined || value === null ? undefined : String(value).trim() }
  const apiRedeploy = read('arturia:apiRedeploy')
  if (apiRedeploy !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(apiRedeploy)) {
    throw new Error('Invalid arturia:apiRedeploy: use 1-64 letters, digits, dots, dashes or underscores')
  }
  const flag = (key: string) => {
    const value = read(key)
    if (value === undefined) return undefined
    if (value !== 'true' && value !== 'false') throw new Error(`Invalid ${key}: use true or false`)
    return value === 'true'
  }
  const workerPaused = flag('arturia:workerPaused')
  const apiAccessLogs = flag('arturia:apiAccessLogs')
  const providerMode = read('arturia:providerMode')
  if (providerMode !== undefined && !(PILOT_PROVIDER_MODES as readonly string[]).includes(providerMode)) {
    throw new Error('Invalid arturia:providerMode: use fixture, fail or catalog (fixture when omitted)')
  }
  const catalogKeys = ['arturia:providerSecretArn', 'arturia:model', 'arturia:tariffVerifiedAt']
  if (providerMode !== 'catalog') {
    const stray = catalogKeys.find(key => read(key) !== undefined)
    if (stray) throw new Error(`Invalid ${stray}: it only applies with -c arturia:providerMode=catalog`)
  }
  const redeploy = {
    ...(apiRedeploy === undefined ? {} : { apiRedeploy }),
    ...(workerPaused === undefined ? {} : { workerPaused }),
    ...(apiAccessLogs === undefined ? {} : { apiAccessLogs }),
    ...(providerMode === undefined ? {} : { providerMode: providerMode as PilotProviderMode }),
  }
  const mode = read('arturia:target') ?? 'synthetic'
  if (mode === 'synthetic') {
    if (providerMode === 'catalog') throw new Error('Invalid arturia:providerMode: catalog requires -c arturia:target=pilot')
    return { synthetic: true, account: SYNTHETIC_ACCOUNT, region: 'us-east-1', bundleDir: 'infra/fixtures/bundles',
      webDistDir: WEB_FIXTURE_DIR, ...redeploy }
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
  const webDistDir = join(webDir, WEB_DIST_PATH)
  if (!isDirectory(webDistDir)) throw new Error(`Missing web build in ${webDistDir}: run npm run build in ARTURIA_WEB_DIR`)
  checkWebDist(webDistDir)
  for (const name of Object.keys(BUNDLES)) {
    if (!existsSync(join(bundleDir, name, 'index.cjs'))) {
      throw new Error(`Missing Lambda bundle "${name}" in ${bundleDir}: run npm run bundle first`)
    }
  }
  // A deployment without the switch would re-enable a paused worker (runbook section 9): state it every time.
  if (workerPaused === undefined) {
    throw new Error('Real pilot synthesis requires -c arturia:workerPaused=true|false (false resumes the worker)')
  }
  const catalog = providerMode === 'catalog' ? catalogContext(read, account, region) : undefined
  return { synthetic: false, account, region, bundleDir, webDir, webDistDir, ...redeploy, ...(catalog && { catalog }) }
}

/** Billable mode: the three values must be valid and the secret must live in the target account and region. */
function catalogContext(read: (key: string) => string | undefined, account: string, region: string): CatalogRuntime {
  const secretArn = read('arturia:providerSecretArn') ?? ''
  const model = read('arturia:model') ?? ''
  const tariffVerifiedAt = read('arturia:tariffVerifiedAt') ?? ''
  if (!isProviderSecretArn(secretArn) || secretArn.split(':').slice(3, 5).join(':') !== `${region}:${account}` ||
      !ENABLED_CATALOG_MODELS.includes(model) || !isFreshDay(tariffVerifiedAt, new Date())) {
    // The message names the context keys only, never the rejected values.
    throw new Error('Invalid arturia:providerMode: catalog requires -c arturia:providerSecretArn, arturia:model and arturia:tariffVerifiedAt')
  }
  return { secretArn, model, tariffVerifiedAt }
}

/** Pilot composition root. Code assets go to the foundation bucket; every role is imported. */
export function createPilotStack(app: App, target: PilotTarget) {
  const stack = new Stack(app, target.synthetic ? 'ArturiaPilotSynthetic' : 'ArturiaPilot', {
    stackName: target.synthetic ? STACKS.synthetic : STACKS.pilot,
    env: { account: target.account, region: target.region },
    description: 'Arturia pilot: chat API, delivery, identity and web hosting',
    synthesizer: new CliCredentialsStackSynthesizer({ fileAssetsBucketName: ARTIFACT_BUCKET, bucketPrefix: ARTIFACT_PREFIX }),
  })
  // Off by default: without it the authorizer configuration is not part of the API deployment's logical ID, so an
  // authorizer change would never reach the stage. Set on the stack so every App that composes the pilot gets it.
  stack.node.setContext(APIGATEWAY_AUTHORIZER_CHANGE_DEPLOYMENT_LOGICAL_ID, true)
  // Cost allocation (D4: the budget filters on Project) and inventory.
  Tags.of(stack).add('Project', 'arturia')
  Tags.of(stack).add('Environment', 'pilot')
  // Same concrete account as the stack: with a token account CDK treats the role as foreign and
  // moves the dropped grants into resource policies. The synthesized template is never versioned.
  const deployed: Target = { partition: Aws.PARTITION, account: target.account, region: target.region }
  const role = (name: RoleName) => iam.Role.fromRoleArn(stack, `${name}Role`, roleArn(deployed, name), { mutable: false })
  const code = (name: BundleName) => lambda.Code.fromAsset(join(target.bundleDir, name))

  // The browser origin is the distribution's domain. The distribution needs the API id (CSP) and the API needs the
  // origin (CORS), so the origin is read lazily once hosting exists; the CloudFormation graph has no cycle.
  let hosting: ReturnType<typeof addWebHosting> | undefined
  const webOrigin = Lazy.string({ produce: () => {
    if (!hosting) throw new Error('Web hosting must be composed before synthesis')
    return hosting.origin
  } })
  const { userPool, client, domain } = addIdentity(stack, { callbackUrl: `${webOrigin}/`, logoutUrl: `${webOrigin}/` })
  const relay = new lambda.Function(stack, 'OutboxRelay', {
    functionName: NAMES.relayFunction, runtime: lambda.Runtime.NODEJS_24_X, handler: 'index.handler',
    code: code('relay'), role: role('relay'), timeout: Duration.seconds(TIMING.relayTimeoutSeconds),
  })
  const { table, turnQueue } = addOutbox(stack, relay, {
    table: NAMES.table, turnQueue: NAMES.turnQueue,
    turnDeadLetters: NAMES.turnDeadLetters, relayDeadLetters: NAMES.relayDeadLetters,
  })
  const worker = addWorker(stack, { table, queue: turnQueue, code: code('worker'), role: role('worker'), functionName: NAMES.workerFunction,
    providerMode: target.providerMode ?? 'fixture', ...(target.catalog && { catalog: target.catalog }), ledgerTableName: NAMES.ledgerTable, paused: target.workerPaused === true })
  const { api, http, stream } = addChatApi(stack, {
    restApiName: NAMES.restApi,
    table, pool: userPool, clientId: client.userPoolClientId, allowedOrigin: webOrigin,
    httpCode: code('http'), httpRole: role('http'), httpFunctionName: NAMES.httpFunction,
    streamCode: code('stream'), streamRole: role('stream'), streamFunctionName: NAMES.streamFunction,
  })
  // The deployment's logical ID hashes the resolved API configuration: a new distribution logical ID changes it.
  // The salt covers values that change without a template change (see README, API Gateway redeployments).
  if (target.apiRedeploy !== undefined) api.latestDeployment!.addToLogicalId({ redeploy: target.apiRedeploy })
  hosting = addWebHosting(stack, {
    distDir: target.webDistDir, api, cognitoDomain: domain, clientId: client.userPoolClientId, publisherRole: role('publisher'),
  })
  // Observability (13.8): one explicit log group per function, the publisher included, and the D4 alarms.
  const own = (fn: lambda.Function) => fn.node.defaultChild as lambda.CfnFunction
  addFunctionLogs(stack, {
    [NAMES.httpFunction]: own(http), [NAMES.streamFunction]: own(stream), [NAMES.workerFunction]: own(worker),
    [NAMES.relayFunction]: own(relay), [NAMES.publisherFunction]: own(hosting.publisher),
  })
  if (target.apiAccessLogs === true) addAccessLogs(stack, api)
  addAlarms(stack, addAlertsTopic(stack))
  if (target.synthetic) new CfnOutput(stack, 'SyntheticSynth', { value: 'true', description: 'Test synthesis: not deployable' })
  return stack
}
