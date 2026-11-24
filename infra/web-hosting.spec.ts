// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { App, aws_cloudfront as cloudfront, type Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { afterAll, describe, expect, test } from 'vitest'
import { NAMES } from './delivery.ts'
import { WEB_FIXTURE_DIR, createPilotStack, resolvePilotTarget, type PilotTarget } from './pilot.ts'
import { CACHE_CONTROL, CONFIG_KEY, IMMUTABLE_PATTERNS, SPA_REWRITE_CODE, checkWebDist } from './web-hosting.ts'

type Resource = { Type: string; Properties?: Record<string, any>; DependsOn?: string | string[] }
type Json = { Resources: Record<string, Resource>; Parameters?: Record<string, unknown>; Outputs?: Record<string, any> }

const tmp: string[] = []
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'arturia-web-')); tmp.push(dir); return dir }
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })

const synthetic = (): PilotTarget => resolvePilotTarget(() => undefined, {})
function synth(target: PilotTarget = synthetic(), tweak?: (stack: Stack) => void) {
  const app = new App({ outdir: tempDir(), analyticsReporting: false })
  const stack = createPilotStack(app, target)
  tweak?.(stack)
  const assembly = app.synth()
  const json = Template.fromStack(stack).toJSON() as Json
  return { stack, json, assembly }
}
let cached: ReturnType<typeof synth> | undefined
const pilot = () => (cached ??= synth())

const entries = (json: Json, type: string) => Object.entries(json.Resources).filter(([, r]) => r.Type === type)
function one(json: Json, type: string): [string, Resource] {
  const list = entries(json, type)
  expect(list, type).toHaveLength(1)
  return list[0]!
}
/** Renders an intrinsic string with symbolic references: {LogicalId} and {LogicalId.Attribute}. */
function render(value: unknown): string {
  if (typeof value === 'string') return value
  const v = value as Record<string, any>
  if (v && 'Fn::Join' in v) { const [separator, parts] = v['Fn::Join']; return (parts as unknown[]).map(render).join(separator) }
  if (v && 'Ref' in v) return `{${v.Ref}}`
  if (v && 'Fn::GetAtt' in v) return `{${(v['Fn::GetAtt'] as string[]).join('.')}}`
  if (v && typeof v['Fn::Sub'] === 'string') return (v['Fn::Sub'] as string).replace(/\$\{([^}]+)\}/g, '{$1}')
  throw new Error('Unsupported expression ' + JSON.stringify(value))
}
const headersPolicy = (json: Json, name: string) => entries(json, 'AWS::CloudFront::ResponseHeadersPolicy')
  .find(([, r]) => r.Properties!.ResponseHeadersPolicyConfig.Name === name)
const directives = (csp: string) => new Map(csp.split(';').map(part => part.trim()).filter(Boolean)
  .map(part => { const [name, ...sources] = part.split(/\s+/); return [name!, sources] as const }))
const deployments = (json: Json) => entries(json, 'Custom::CDKBucketDeployment')
const deploymentByCache = (json: Json, cache: string) => {
  const found = deployments(json).filter(([, r]) => r.Properties!.SystemMetadata?.['cache-control'] === cache)
  expect(found, cache).toHaveLength(1)
  return found[0]!
}
function origins(json: Json) {
  const [restApi] = one(json, 'AWS::ApiGateway::RestApi')
  const [domain] = one(json, 'AWS::Cognito::UserPoolDomain')
  const [distribution] = one(json, 'AWS::CloudFront::Distribution')
  return {
    api: `https://{${restApi}}.execute-api.us-east-1.{AWS::URLSuffix}`,
    cognito: `https://{${domain}}.auth.us-east-1.amazoncognito.com`,
    web: `https://{${distribution}.DomainName}`,
    distribution,
  }
}
/** aws s3 sync filter semantics as used by BucketDeployment: everything is included, then excludes and includes apply in order. */
function selects(properties: Record<string, any>, key: string) {
  const match = (pattern: string) => new RegExp('^' + pattern.split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(key)
  let included = true
  for (const pattern of properties.Exclude ?? []) if (match(pattern)) included = false
  for (const pattern of properties.Include ?? []) if (match(pattern)) included = true
  return included
}
const FIXTURE_KEYS = ['index.html', 'robots.txt', 'main-AB12CD34.js', 'chunk-QW34ER56.js', 'styles-EF56GH78.css', 'media/logo-IJ90KL12.svg']
const IMMUTABLE_KEYS = FIXTURE_KEYS.filter(key => /\.(js|css)$/.test(key) || key.startsWith('media/'))

/** A web checkout whose production build is a copy of the fixture. */
function webCheckout(change?: (dist: string) => void) {
  const web = tempDir()
  const dist = join(web, 'dist', 'arturia', 'browser')
  mkdirSync(dist, { recursive: true })
  cpSync(WEB_FIXTURE_DIR, dist, { recursive: true })
  change?.(dist)
  return { web, dist }
}

test('bucket_private_oac_only', () => {
  const { json } = pilot()
  const [bucketId, bucket] = one(json, 'AWS::S3::Bucket')
  expect(bucket.Properties).toMatchObject({
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
  })
  expect(bucket.Properties!.WebsiteConfiguration).toBeUndefined()
  expect(render(bucket.Properties!.BucketName)).toBe('arturia-pilot-web-{AWS::AccountId}-{AWS::Region}')
  const [, bucketPolicy] = one(json, 'AWS::S3::BucketPolicy')
  expect(bucketPolicy.Properties!.Bucket).toEqual({ Ref: bucketId })
  const { distribution } = origins(json)
  const statements = bucketPolicy.Properties!.PolicyDocument.Statement as Record<string, any>[]
  const allows = statements.filter(s => s.Effect === 'Allow')
  expect(allows).toHaveLength(1)
  expect(allows[0]).toMatchObject({ Action: 's3:GetObject', Principal: { Service: 'cloudfront.amazonaws.com' } })
  expect(render(allows[0]!.Resource)).toBe(`{${bucketId}.Arn}/*`)
  expect(render(allows[0]!.Condition.StringEquals['AWS:SourceArn'])).toContain(`{${distribution}}`)
  const denies = statements.filter(s => s.Effect === 'Deny')
  expect(denies).toEqual([expect.objectContaining({ Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })])
  const [oacId, oac] = one(json, 'AWS::CloudFront::OriginAccessControl')
  expect(oac.Properties!.OriginAccessControlConfig).toMatchObject({
    OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' })
  const config = json.Resources[distribution]!.Properties!.DistributionConfig
  expect(config.Origins).toHaveLength(1)
  expect(config.Origins[0]).toMatchObject({ OriginAccessControlId: { 'Fn::GetAtt': [oacId, 'Id'] }, S3OriginConfig: { OriginAccessIdentity: '' } })
  expect(render(config.Origins[0].DomainName)).toBe(`{${bucketId}.RegionalDomainName}`)
  expect(config.Logging).toBeUndefined()
  expect(config.Aliases).toBeUndefined()
  expect(config.ViewerCertificate).toBeUndefined()
}, 30_000)

test('csp_is_complete_and_limits_connect_src', () => {
  const { json } = pilot()
  const expected = origins(json)
  for (const name of [NAMES.webHeaders, NAMES.configHeaders]) {
    const [, policy] = headersPolicy(json, name)!
    const security = policy.Properties!.ResponseHeadersPolicyConfig.SecurityHeadersConfig
    expect(security.ContentSecurityPolicy.Override).toBe(true)
    const csp = directives(render(security.ContentSecurityPolicy.ContentSecurityPolicy))
    expect(csp.get('default-src')).toEqual(["'self'"])
    expect(csp.get('script-src')).toEqual(["'self'"])
    // Angular inserts component styles at runtime; a nonce needs per-response HTML, which static hosting cannot produce.
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    // 'self' covers the fetch of /config.json; the rest are the API and the Cognito token endpoint.
    expect(csp.get('connect-src')).toEqual(["'self'", expected.api, expected.cognito])
    expect(csp.get('img-src')).toEqual(["'self'", 'data:'])
    expect(csp.get('font-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'self'"])
    expect(csp.get('form-action')).toEqual(["'self'"])
    expect(csp.get('frame-ancestors')).toEqual(["'none'"])
    for (const sources of csp.values()) {
      for (const source of sources) expect(source).not.toMatch(/^\*|unsafe-eval|^https?:$|^http:/)
    }
    expect([...csp.values()].flat().filter(source => source === "'unsafe-inline'")).toHaveLength(1)
    expect(security.StrictTransportSecurity).toEqual({ AccessControlMaxAgeSec: 31_536_000, IncludeSubdomains: true, Override: true })
    expect(security.ContentTypeOptions).toEqual({ Override: true })
    expect(security.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true })
    expect(security.ReferrerPolicy).toEqual({ ReferrerPolicy: 'no-referrer', Override: true })
  }
}, 30_000)

test('csp_does_not_reference_stage_url', () => {
  const { json } = pilot()
  const [stage] = one(json, 'AWS::ApiGateway::Stage')
  const [deployment] = one(json, 'AWS::ApiGateway::Deployment')
  for (const name of [NAMES.webHeaders, NAMES.configHeaders]) {
    const [, policy] = headersPolicy(json, name)!
    const text = JSON.stringify(policy)
    expect(text).not.toContain(stage)
    expect(text).not.toContain(deployment)
    expect(text).not.toContain('/prod')
  }
}, 30_000)

test('config_json_derived_from_stack_and_not_cached', () => {
  const { json, assembly } = pilot()
  const expected = origins(json)
  const [, config] = deploymentByCache(json, CACHE_CONTROL.config)
  expect(config.Properties).toMatchObject({ Prune: false, SystemMetadata: { 'cache-control': 'no-store', 'content-type': 'application/json' } })
  // Read the staged source and replace each deploy-time marker with its expression.
  const manifest = JSON.parse(readFileSync(join(assembly.directory, `${pilot().stack.artifactId}.assets.json`), 'utf8'))
  const staged = Object.values(manifest.files as Record<string, { source: { path: string } }>)
    .map(file => join(assembly.directory, file.source.path, CONFIG_KEY))
    .filter(path => { try { readFileSync(path); return true } catch { return false } })
  expect(staged).toHaveLength(1)
  let text = readFileSync(staged[0]!, 'utf8')
  const markers = config.Properties!.SourceMarkers[0] as Record<string, unknown>
  for (const [marker, value] of Object.entries(markers)) text = text.split(marker).join(render(value))
  const [stage] = one(json, 'AWS::ApiGateway::Stage')
  const [client] = one(json, 'AWS::Cognito::UserPoolClient')
  expect(JSON.parse(text)).toEqual({
    version: 1,
    apiBaseUrl: `${expected.api}/{${stage}}/`,
    cognito: { domain: expected.cognito, clientId: `{${client}}`, scopes: ['openid', 'arturia/access'] },
    redirectUri: `${expected.web}/`,
    logoutUri: `${expected.web}/`,
  })
  // CloudFront: dedicated behavior without cache, rewrite or redirect, and no-store forced on the response.
  const distribution = json.Resources[expected.distribution]!.Properties!.DistributionConfig
  const behaviors = distribution.CacheBehaviors.filter((b: any) => b.PathPattern === `/${CONFIG_KEY}`)
  expect(behaviors).toHaveLength(1)
  const [behavior] = behaviors
  expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
  expect(behavior.ViewerProtocolPolicy).toBe('https-only')
  expect(behavior.FunctionAssociations).toBeUndefined()
  expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD'])
  const [headersId, headers] = headersPolicy(json, NAMES.configHeaders)!
  expect(behavior.ResponseHeadersPolicyId).toEqual({ Ref: headersId })
  expect(headers.Properties!.ResponseHeadersPolicyConfig.CustomHeadersConfig.Items)
    .toEqual([{ Header: 'Cache-Control', Value: 'no-store', Override: true }])
}, 30_000)

test('cache_policy_follows_origin_headers_per_file_class', () => {
  const { json } = pilot()
  const { distribution } = origins(json)
  const config = json.Resources[distribution]!.Properties!.DistributionConfig
  const [policyId, policy] = one(json, 'AWS::CloudFront::CachePolicy')
  expect(config.DefaultCacheBehavior.CachePolicyId).toEqual({ Ref: policyId })
  const settings = policy.Properties!.CachePolicyConfig
  // MinTTL 0: CloudFront honors no-cache and caches max-age responses up to MaxTTL.
  expect(settings).toMatchObject({ Name: NAMES.webCachePolicy, MinTTL: 0, DefaultTTL: 0, MaxTTL: 31_536_000 })
  expect(settings.ParametersInCacheKeyAndForwardedToOrigin).toMatchObject({
    EnableAcceptEncodingGzip: true, EnableAcceptEncodingBrotli: true,
    HeadersConfig: { HeaderBehavior: 'none' }, CookiesConfig: { CookieBehavior: 'none' }, QueryStringsConfig: { QueryStringBehavior: 'none' } })
  expect(CACHE_CONTROL).toEqual({ immutable: 'public, max-age=31536000, immutable', revalidate: 'no-cache', config: 'no-store' })
  // Each file of the build is published by exactly one of the two build deployments (config.json has its own source).
  const build = [deploymentByCache(json, CACHE_CONTROL.immutable), deploymentByCache(json, CACHE_CONTROL.revalidate)]
  const owner = (key: string) => build.filter(([, r]) => selects(r.Properties!, key))
    .map(([, r]) => r.Properties!.SystemMetadata['cache-control'])
  for (const key of FIXTURE_KEYS) {
    expect(owner(key), key).toEqual([IMMUTABLE_KEYS.includes(key) ? CACHE_CONTROL.immutable : CACHE_CONTROL.revalidate])
  }
  // Errors (a 403 for a missing object) are not cached, so a deployment is visible on the next request.
  expect(config.CustomErrorResponses).toEqual([{ ErrorCode: 403, ErrorCachingMinTTL: 0 }, { ErrorCode: 404, ErrorCachingMinTTL: 0 }])
  expect(config.DefaultCacheBehavior).toMatchObject({ ViewerProtocolPolicy: 'redirect-to-https', Compress: true, AllowedMethods: ['GET', 'HEAD'] })
  expect(config.DefaultRootObject).toBe('index.html')
  expect(config.PriceClass).toBe('PriceClass_100')
}, 30_000)

test('deployments_do_not_prune_each_other', () => {
  const { json } = pilot()
  const [assetsId, assets] = deploymentByCache(json, CACHE_CONTROL.immutable)
  const [pagesId, pages] = deploymentByCache(json, CACHE_CONTROL.revalidate)
  const [, config] = deploymentByCache(json, CACHE_CONTROL.config)
  expect(deployments(json)).toHaveLength(3)
  // Hashed files are never deleted: open tabs, the window between deployments and a rollback still find old chunks.
  expect(assets.Properties).toMatchObject({ Prune: false, Exclude: ['*'], Include: [...IMMUTABLE_PATTERNS] })
  expect(pages.Properties).toMatchObject({ Prune: true, Exclude: [...IMMUTABLE_PATTERNS, CONFIG_KEY] })
  expect(pages.Properties!.Include).toBeUndefined()
  // The only pruning deployment deletes objects inside its own filter: never hashed files or config.json.
  for (const key of [...FIXTURE_KEYS, CONFIG_KEY, 'chunk-OLD00000.js', 'old-page.txt']) {
    const pruned = selects(pages.Properties!, key)
    expect(pruned, key).toBe(key === 'old-page.txt' || (!IMMUTABLE_KEYS.includes(key) && FIXTURE_KEYS.includes(key)))
  }
  // Order: new bundles before the index that references them, and config.json last.
  expect([pages.DependsOn].flat()).toContain(assetsId)
  expect([config.DependsOn].flat()).toContain(pagesId)
  for (const [, deployment] of deployments(json)) {
    expect(deployment.Properties!.DistributionId).toBeUndefined()
    expect(deployment.Properties!.DistributionPaths).toBeUndefined()
  }
}, 30_000)

test('spa_rewrite_excludes_config_json', () => {
  const handler = runInNewContext(`${SPA_REWRITE_CODE}\nhandler`) as (event: { request: { uri: string } }) => { uri: string }
  const rewrite = (uri: string) => handler({ request: { uri } }).uri
  expect(rewrite('/chat')).toBe('/index.html')
  expect(rewrite('/chat/abc-123')).toBe('/index.html')
  expect(rewrite('/')).toBe('/index.html')
  expect(rewrite('/chat/')).toBe('/index.html')
  expect(rewrite(`/${CONFIG_KEY}`)).toBe(`/${CONFIG_KEY}`)
  expect(rewrite('/main-AB12CD34.js')).toBe('/main-AB12CD34.js')
  expect(rewrite('/media/logo-IJ90KL12.svg')).toBe('/media/logo-IJ90KL12.svg')
  const { json } = pilot()
  const [functionId, fn] = one(json, 'AWS::CloudFront::Function')
  expect(fn.Properties).toMatchObject({ Name: NAMES.rewriteFunction, AutoPublish: true,
    FunctionConfig: { Runtime: 'cloudfront-js-2.0' }, FunctionCode: SPA_REWRITE_CODE })
  const config = json.Resources[origins(json).distribution]!.Properties!.DistributionConfig
  expect(config.DefaultCacheBehavior.FunctionAssociations).toEqual([
    { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [functionId, 'FunctionARN'] } }])
  for (const behavior of config.CacheBehaviors) expect(behavior.FunctionAssociations).toBeUndefined()
  for (const response of config.CustomErrorResponses) {
    expect(response.ResponsePagePath).toBeUndefined()
    expect(response.ResponseCode).toBeUndefined()
  }
}, 30_000)

test('callback_logout_and_cors_equal_distribution_origin', () => {
  const { json } = pilot()
  const { web } = origins(json)
  const [, client] = one(json, 'AWS::Cognito::UserPoolClient')
  expect(client.Properties!.CallbackURLs.map(render)).toEqual([`${web}/`])
  expect(client.Properties!.LogoutURLs.map(render)).toEqual([`${web}/`])
  const functions = entries(json, 'AWS::Lambda::Function').map(([, r]) => r.Properties!)
  for (const name of [NAMES.httpFunction, NAMES.streamFunction]) {
    expect(render(functions.find(fn => fn.FunctionName === name)!.Environment.Variables.ARTURIA_ALLOWED_ORIGIN)).toBe(web)
  }
  for (const [, response] of entries(json, 'AWS::ApiGateway::GatewayResponse')) {
    expect(render(response.Properties!.ResponseParameters['gatewayresponse.header.Access-Control-Allow-Origin'])).toBe(`'${web}'`)
  }
  const preflights = entries(json, 'AWS::ApiGateway::Method').filter(([, r]) => r.Properties!.HttpMethod === 'OPTIONS')
  expect(preflights.length).toBeGreaterThan(0)
  for (const [, preflight] of preflights) {
    const [response] = preflight.Properties!.Integration.IntegrationResponses
    expect(render(response.ResponseParameters['method.response.header.Access-Control-Allow-Origin'])).toBe(`'${web}'`)
  }
  // The provisional parameters are gone: every origin derives from the distribution.
  // The origin is derived, never a parameter. The only other parameter is the alerts email (13.8), never versioned.
  expect(Object.keys(json.Parameters ?? {}).filter(name => name !== 'BootstrapVersion').sort()).toEqual(['AlertEmail', 'CognitoDomainPrefix'])
  const [, restApi] = one(json, 'AWS::ApiGateway::RestApi')
  expect(JSON.stringify(restApi)).not.toContain(origins(json).distribution)
  expect(render(json.Outputs!.WebUrl.Value)).toBe(`${web}/`)
}, 30_000)

describe('api_gateway_redeploys_when_the_origin_changes', () => {
  test('api gateway configuration references no parameters, imports or dynamic references', () => {
    const { json } = pilot()
    const parameters = new Set(Object.keys(json.Parameters ?? {}))
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`))
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'Ref') expect(parameters.has(inner as string), path).toBe(false)
          expect(key, path).not.toBe('Fn::ImportValue')
          walk(inner, `${path}.${key}`)
        }
      } else if (typeof value === 'string') expect(value, path).not.toContain('{{resolve:')
    }
    for (const [id, resource] of Object.entries(json.Resources)) {
      if (resource.Type.startsWith('AWS::ApiGateway::')) walk(resource.Properties, id)
    }
  }, 30_000)

  test('a new distribution logical ID yields a new deployment and the stage follows it', () => {
    const deploymentOf = (json: Json) => {
      const [id] = one(json, 'AWS::ApiGateway::Deployment')
      const [, stage] = one(json, 'AWS::ApiGateway::Stage')
      expect(stage.Properties!.DeploymentId).toEqual({ Ref: id })
      return id
    }
    const base = deploymentOf(pilot().json)
    expect(deploymentOf(synth().json)).toBe(base)
    const moved = synth(undefined, stack => {
      const distribution = stack.node.findAll().find((c): c is cloudfront.Distribution => c instanceof cloudfront.Distribution)!
      ;(distribution.node.defaultChild as cloudfront.CfnDistribution).overrideLogicalId('WebDistributionReplaced')
    })
    expect(deploymentOf(moved.json)).not.toBe(base)
  }, 60_000)

  test('authorizer configuration is part of the deployment logical ID', () => {
    // Off by default in aws-cdk-lib 2.278: without it, an authorizer change would never reach the stage.
    const { json } = pilot()
    const [authorizer] = one(json, 'AWS::ApiGateway::Authorizer')
    const [, deployment] = one(json, 'AWS::ApiGateway::Deployment')
    expect([deployment.DependsOn].flat()).toContain(authorizer)
  }, 30_000)

  test('the redeploy context forces a new deployment without changing anything else', () => {
    const base = synth().json
    const context = (value: string) => resolvePilotTarget(key => (key === 'arturia:apiRedeploy' ? value : undefined), {})
    const first = synth(context('2026-11-24.1')).json
    const second = synth(context('2026-11-24.2')).json
    const deploymentId = (json: Json) => one(json, 'AWS::ApiGateway::Deployment')[0]
    expect(new Set([deploymentId(base), deploymentId(first), deploymentId(second)]).size).toBe(3)
    const others = (json: Json) => Object.entries(json.Resources)
      .filter(([, r]) => !['AWS::ApiGateway::Deployment', 'AWS::ApiGateway::Stage', 'AWS::Lambda::Permission'].includes(r.Type))
      .map(([id, r]) => [id, r])
    expect(others(first)).toEqual(others(base))
    expect(() => context('no spaces allowed')).toThrow(/arturia:apiRedeploy/)
  }, 60_000)
})

test('publisher_runs_on_one_named_function_and_layer', () => {
  const { json } = pilot()
  const handlers = entries(json, 'AWS::Lambda::Function')
    .filter(([, r]) => r.Properties!.FunctionName === NAMES.publisherFunction)
  expect(handlers).toHaveLength(1)
  const [handlerId, handler] = handlers[0]!
  const [layerId, layer] = one(json, 'AWS::Lambda::LayerVersion')
  expect(layer.Properties!.LayerName).toBe(NAMES.publisherLayer)
  expect(handler.Properties!.Layers).toEqual([{ Ref: layerId }])
  expect(JSON.stringify(handler.Properties!.Role)).toContain(':role/arturia-pilot-publisher')
  for (const [, deployment] of deployments(json)) {
    expect(deployment.Properties!.ServiceToken).toEqual({ 'Fn::GetAtt': [handlerId, 'Arn'] })
  }
}, 30_000)

test('template_has_no_dependency_cycles', () => {
  const { json } = pilot()
  const ids = new Set(Object.keys(json.Resources))
  const references = (value: unknown, found = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach(item => references(item, found))
    else if (typeof value === 'string') {
      for (const [, name] of value.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9.]+)?\}/g)) if (ids.has(name!)) found.add(name!)
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'Ref' && ids.has(inner as string)) found.add(inner as string)
        else if (key === 'Fn::GetAtt') found.add((inner as string[])[0]!)
        else references(inner, found)
      }
    }
    return found
  }
  const edges = new Map(Object.entries(json.Resources).map(([id, r]) =>
    [id, new Set([...references(r.Properties), ...[r.DependsOn ?? []].flat()])]))
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'open') throw new Error('cycle: ' + [...trail, id].join(' -> '))
    state.set(id, 'open')
    for (const next of edges.get(id) ?? []) visit(next, [...trail, id])
    state.set(id, 'done')
  }
  for (const id of ids) visit(id, [])
  // The distribution reaches the API only through its id (CSP), never through the stage or the Lambdas.
  const { distribution } = origins(json)
  const reach = (from: string, seen = new Set<string>()): Set<string> => {
    for (const next of edges.get(from) ?? []) if (!seen.has(next)) { seen.add(next); reach(next, seen) }
    return seen
  }
  const reachable = [...reach(distribution)].map(id => json.Resources[id]!.Type)
  for (const type of ['AWS::ApiGateway::Stage', 'AWS::ApiGateway::Deployment', 'AWS::Lambda::Function', 'AWS::Cognito::UserPoolClient']) {
    expect(reachable, type).not.toContain(type)
  }
}, 30_000)

describe('web_dist_is_checked_before_synthesis', () => {
  test('the fixture is a valid production build', () => {
    expect(() => checkWebDist(WEB_FIXTURE_DIR)).not.toThrow()
  })

  test.each([
    ['without index.html', (dist: string) => rmSync(join(dist, 'index.html')), /index\.html/],
    ['with a config.json', (dist: string) => writeFileSync(join(dist, CONFIG_KEY), '{}'), /config\.json/],
    ['with an unhashed bundle', (dist: string) => writeFileSync(join(dist, 'main.js'), ''), /content hash/],
    ['with an unhashed media file', (dist: string) => writeFileSync(join(dist, 'media', 'logo.svg'), ''), /content hash/],
    ['with an inline script', (dist: string) => writeFileSync(join(dist, 'index.html'),
      '<html><body><script>alert(1)</script><script src="main-AB12CD34.js"></script></body></html>'), /inline script/],
    ['with an inline event handler', (dist: string) => writeFileSync(join(dist, 'index.html'),
      '<html><body><link rel="stylesheet" href="styles-EF56GH78.css" onload="x()"></body></html>'), /inline script/],
  ])('rejects a build %s', (_name, change, message) => {
    const { dist } = webCheckout(change)
    expect(() => checkWebDist(dist)).toThrow(message)
  })

  test('the real synthesis reads the production build of the web checkout', () => {
    const located = { 'arturia:target': 'pilot', 'arturia:account': '111111111111', 'arturia:region': 'us-east-1' }
    const read = (key: string) => located[key as keyof typeof located]
    const bundles = tempDir()
    for (const name of ['stream', 'relay', 'http', 'worker']) {
      mkdirSync(join(bundles, name))
      writeFileSync(join(bundles, name, 'index.cjs'), 'exports.handler=async()=>{}')
    }
    const empty = tempDir()
    expect(() => resolvePilotTarget(read, { ARTURIA_WEB_DIR: empty }, bundles)).toThrow(/npm run build/)
    const broken = webCheckout(dist => writeFileSync(join(dist, CONFIG_KEY), '{}'))
    expect(() => resolvePilotTarget(read, { ARTURIA_WEB_DIR: broken.web }, bundles)).toThrow(/config\.json/)
    const { web, dist } = webCheckout()
    expect(resolvePilotTarget(read, { ARTURIA_WEB_DIR: web }, bundles)).toMatchObject({ synthetic: false, webDir: web, webDistDir: dist })
  })
})
