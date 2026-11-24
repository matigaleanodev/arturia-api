// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Matias Galeano

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CfnOutput, Duration, Fn, Stack, aws_apigateway as gateway, aws_cloudfront as cloudfront, aws_cognito as cognito,
  aws_iam as iam, aws_lambda as lambda, aws_s3 as s3, aws_s3_deployment as deploy,
} from 'aws-cdk-lib'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import type { Construct } from 'constructs'
import { ARTURIA_ACCESS_SCOPE } from '../src/identity/actor.ts'
import { NAMES, WEB_BUCKET } from './delivery.ts'

/** Runtime configuration published next to the build; the build itself never contains it. */
export const CONFIG_KEY = 'config.json'
/** Files Angular names with a content hash (`outputHashing: all`): safe to cache for a year. */
export const IMMUTABLE_PATTERNS = ['*.js', '*.css', 'media/*'] as const
export const CACHE_CONTROL = {
  immutable: 'public, max-age=31536000, immutable',
  /** index.html and any other unhashed file: the browser and CloudFront revalidate on every use. */
  revalidate: 'no-cache',
  config: 'no-store',
} as const
const HASHED = /-[A-Z0-9]{8}\.[A-Za-z0-9]+$/

/**
 * Viewer-request rewrite for client-side routes: a path whose last segment has no extension serves
 * index.html. Files (bundles, media, config.json) pass through unchanged, so a missing file stays a 403/404
 * from S3 instead of becoming HTML. config.json also has its own behavior without this function.
 */
export const SPA_REWRITE_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/${CONFIG_KEY}') return request;
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`

/** Fails when a production build would break the cache classes or the CSP of the hosting. */
export function checkWebDist(dir: string) {
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`Web build without index.html in ${dir}: run npm run build in ARTURIA_WEB_DIR`)
  const files = (readdirSync(dir, { recursive: true }) as string[]).map(file => file.split('\\').join('/'))
    .filter(file => statSync(join(dir, file)).isFile())
  if (files.some(file => file.split('/').at(-1) === CONFIG_KEY)) {
    throw new Error(`The web build must not contain ${CONFIG_KEY}: the hosting publishes it per deployment`)
  }
  const immutable = files.filter(file => /\.(js|css)$/.test(file) || file.startsWith('media/'))
  const unhashed = immutable.filter(file => !HASHED.test(file))
  if (unhashed.length) throw new Error(`Web files cached as immutable need a content hash: ${unhashed.join(', ')}`)
  const html = readFileSync(join(dir, 'index.html'), 'utf8')
  const inlineScript = [...html.matchAll(/<script\b([^>]*)>/gi)].some(([, attributes]) => !/\bsrc\s*=/i.test(attributes!))
  if (inlineScript || /<[^>]+\son[a-z]+\s*=/i.test(html)) {
    throw new Error("index.html has an inline script or event handler, which the CSP (script-src 'self') blocks")
  }
}

/** CSP of the web client. Origins are CloudFormation strings built from ids, never from the stage URL. */
export function contentSecurityPolicy(origins: { readonly api: string; readonly cognito: string }) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Angular adds component styles at runtime; a nonce needs per-response HTML, which static hosting cannot produce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${origins.api} ${origins.cognito}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export interface WebHostingProps {
  /** Angular production build (`dist/arturia/browser`), checked with `checkWebDist`. */
  readonly distDir: string
  readonly api: gateway.RestApi
  readonly cognitoDomain: cognito.UserPoolDomain
  readonly clientId: string
  /** Predefined role of the BucketDeployment handler. The stack creates no IAM. */
  readonly publisherRole: iam.IRole
}

/**
 * Private S3 bucket behind CloudFront with OAC. Three deployments publish the build by cache class and the
 * runtime configuration. Only the pages deployment prunes, within its own filter: hashed files are never deleted,
 * so open tabs, the window between deployments and a rollback still find their chunks. There are no
 * invalidations: hashed files are immutable, index.html is revalidated and config.json is never cached.
 */
export function addWebHosting(scope: Construct, props: WebHostingProps) {
  checkWebDist(props.distDir)
  const stack = Stack.of(scope)
  const bucket = new s3.Bucket(scope, 'WebBucket', {
    bucketName: Fn.sub(WEB_BUCKET),
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    enforceSSL: true,
  })
  const origin = S3BucketOrigin.withOriginAccessControl(bucket)

  const apiOrigin = `https://${props.api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`
  const cognitoOrigin = props.cognitoDomain.baseUrl()
  const securityHeadersBehavior: cloudfront.ResponseSecurityHeadersBehavior = {
    contentSecurityPolicy: { contentSecurityPolicy: contentSecurityPolicy({ api: apiOrigin, cognito: cognitoOrigin }), override: true },
    strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
  }
  const webHeaders = new cloudfront.ResponseHeadersPolicy(scope, 'WebHeaders', {
    responseHeadersPolicyName: NAMES.webHeaders, securityHeadersBehavior,
  })
  const configHeaders = new cloudfront.ResponseHeadersPolicy(scope, 'ConfigHeaders', {
    responseHeadersPolicyName: NAMES.configHeaders, securityHeadersBehavior,
    customHeadersBehavior: { customHeaders: [{ header: 'Cache-Control', value: CACHE_CONTROL.config, override: true }] },
  })
  // MinTTL 0: CloudFront honors each object's Cache-Control (no-cache is revalidated, max-age is cached up to MaxTTL).
  const cachePolicy = new cloudfront.CachePolicy(scope, 'WebCache', {
    cachePolicyName: NAMES.webCachePolicy,
    minTtl: Duration.seconds(0), defaultTtl: Duration.seconds(0), maxTtl: Duration.days(365),
    enableAcceptEncodingGzip: true, enableAcceptEncodingBrotli: true,
  })
  const rewrite = new cloudfront.Function(scope, 'SpaRewrite', {
    functionName: NAMES.rewriteFunction, runtime: cloudfront.FunctionRuntime.JS_2_0,
    code: cloudfront.FunctionCode.fromInline(SPA_REWRITE_CODE), comment: 'Arturia pilot: client-side routes',
  })
  const distribution = new cloudfront.Distribution(scope, 'WebDistribution', {
    comment: 'Arturia pilot web client',
    defaultRootObject: 'index.html',
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    // Keep S3 errors as they are (no SPA fallback here) and do not cache them.
    errorResponses: [403, 404].map(httpStatus => ({ httpStatus, ttl: Duration.seconds(0) })),
    defaultBehavior: {
      origin, cachePolicy, responseHeadersPolicy: webHeaders, compress: true,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    },
    additionalBehaviors: {
      [`/${CONFIG_KEY}`]: {
        origin, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, responseHeadersPolicy: configHeaders, compress: true,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
    },
  })
  const webOrigin = `https://${distribution.distributionDomainName}`

  const build = deploy.Source.asset(props.distDir)
  const common = { destinationBucket: bucket, role: props.publisherRole }
  const assets = new deploy.BucketDeployment(scope, 'WebAssets', {
    ...common, sources: [build], prune: false, exclude: ['*'], include: [...IMMUTABLE_PATTERNS],
    cacheControl: [deploy.CacheControl.fromString(CACHE_CONTROL.immutable)],
  })
  const pages = new deploy.BucketDeployment(scope, 'WebPages', {
    ...common, sources: [build], prune: true, exclude: [...IMMUTABLE_PATTERNS, CONFIG_KEY],
    cacheControl: [deploy.CacheControl.fromString(CACHE_CONTROL.revalidate)],
  })
  const config = new deploy.BucketDeployment(scope, 'WebConfig', {
    ...common, prune: false, contentType: 'application/json',
    cacheControl: [deploy.CacheControl.fromString(CACHE_CONTROL.config)],
    sources: [deploy.Source.jsonData(CONFIG_KEY, {
      version: 1,
      apiBaseUrl: props.api.url,
      cognito: { domain: cognitoOrigin, clientId: props.clientId, scopes: ['openid', ARTURIA_ACCESS_SCOPE] },
      redirectUri: `${webOrigin}/`,
      logoutUri: `${webOrigin}/`,
    })],
  })
  // New bundles land before the index.html that references them; config.json goes last.
  pages.node.addDependency(assets)
  config.node.addDependency(pages)
  namePublisher(scope, assets, [pages, config])

  new CfnOutput(scope, 'WebUrl', { value: `${webOrigin}/` })
  return { bucket, distribution, origin: webOrigin }
}

/**
 * The three deployments share one handler (a singleton). Each deployment also instantiates an AWS CLI layer,
 * but the handler uses only the first one: drop the others and give the handler and layer the predictable
 * names that the foundation roles are scoped to.
 */
function namePublisher(scope: Construct, first: deploy.BucketDeployment, others: deploy.BucketDeployment[]) {
  const handlers = Stack.of(scope).node.findAll()
    .filter((c): c is lambda.Function => c instanceof lambda.Function && c.node.id.startsWith('Custom::CDKBucketDeployment'))
  if (handlers.length !== 1) throw new Error(`Expected one BucketDeployment handler, found ${handlers.length}`)
  ;(handlers[0]!.node.defaultChild as lambda.CfnFunction).functionName = NAMES.publisherFunction
  const layer = first.node.findChild('AwsCliLayer') as lambda.LayerVersion
  ;(layer.node.defaultChild as lambda.CfnLayerVersion).layerName = NAMES.publisherLayer
  for (const deployment of others) {
    if (!deployment.node.tryRemoveChild('AwsCliLayer')) throw new Error('BucketDeployment layer layout changed')
  }
}
