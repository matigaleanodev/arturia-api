# Arturia API

[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
[![AWS CDK 2](https://img.shields.io/badge/AWS%20CDK-2-FF9900)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[Español](README.es.md)

Backend for Arturia, a personal assistant with conversations organized by user and scope. The [HTTP contract](contracts/openapi.json) and [SSE schema](contracts/sse.schema.json) define the web client interface. AWS CDK infrastructure lives in `infra/`.

Conversation titles and message text each accept up to 393,216 UTF-8 bytes. Scope, conversation, and turn IDs in paths accept up to 256 UTF-8 bytes each. Oversized values return HTTP 400 with code `INVALID_REQUEST`.

The turn events endpoint accepts an optional nonnegative integer `after` cursor. It reads persisted blocks, rechecks the current session and scope grant before each batch, and closes after the terminal status, revocation, or the connection time limit. Reconnect with the last text sequence received. Heartbeat comments carry no data.

`addChatStream` composes the delivery handler with the chat table, Cognito pool and browser client ID. The construct exposes its Regional REST API for additional routes. Delivery requires an existing Arturia session and has independent reserved concurrency.

## Infrastructure

`npm run bundle` builds one self-contained Node.js 24 bundle per Lambda handler in `dist/bundles/<name>/index.cjs`. `BUNDLES` in `infra/delivery.ts` lists the entry points, which must live in `src/`.

| Bundle | Handler | Configuration |
|---|---|---|
| `http` | REST proxy for conversations and turns (`src/http/turns.lambda.ts`). The actor comes only from the Cognito authorizer claims for this app client with the `arturia/access` scope, and the session is revalidated in DynamoDB. | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID`, `ARTURIA_ALLOWED_ORIGIN` |
| `worker` | SQS consumer of turns (`src/chat/generate.lambda.ts`). `retry`, invalid messages and failures become `batchItemFailures`; in a FIFO batch the remaining messages are returned unprocessed. | `ARTURIA_TABLE_NAME`, `ARTURIA_ENVIRONMENT`, `ARTURIA_PROVIDER_MODE` |
| `stream` | SSE turn events in streaming mode. | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID`, `ARTURIA_ALLOWED_ORIGIN` |
| `relay` | DynamoDB stream outbox relay to SQS. | `ARTURIA_TABLE_NAME`, `ARTURIA_TURN_QUEUE_URL` |

The `http` and `worker` handlers read and validate their configuration once per execution environment. An invalid configuration fails closed: HTTP answers `500 INTERNAL_ERROR` with the public error shape, and the worker fails the invocation so every message returns to the queue. `ARTURIA_PROVIDER_MODE` currently accepts only the non-billable pilot fixtures, and only with `ARTURIA_ENVIRONMENT=pilot`: `fixture` emits three synthetic blocks one second apart, and `fail` never runs the turn so the message reaches the dead-letter queue. Logs are structured JSON with a code, UUID identifiers, HTTP status and error class only, never message text, prompts, claims or secrets.

Worker durations live in `src/config/timing.ts`, shared by the code and the CDK composition, and are validated at synthesis: provider timeout (45 s) plus a closing margin is below the worker timeout (60 s), which the turn lease (75 s) covers, and the `TurnQueue` visibility (360 s, six times the function timeout) exceeds worker timeout plus lease, so a redelivery always finds an expired lease. The event source delivers one message per invocation with partial batch responses and a maximum concurrency of 2, instead of reserved concurrency. Messages are retained for 14 days and move to the FIFO dead-letter queue after 5 receives. A redelivered turn whose send crossed the provider boundary ends as `SEND_UNCERTAIN` and is never sent or reserved again. The message group is a hash of user and scope: a retried turn holds back later turns of the same user and scope for the whole visibility, never those of another scope or user.

A single Regional REST API (`infra/chat-api.ts`) serves every route of the contract, listed once in `src/http/routes.ts`. Every route requires the Cognito authorizer with the `arturia/access` scope; only the CORS preflights are anonymous. The SSE route invokes the `stream` function with response streaming and a 29 s integration timeout, below the 15-minute streaming limit of REST APIs; clients reconnect with the `after` cursor. CORS allows one exact HTTPS origin, the web distribution's domain derived inside the pilot stack, without credentials: preflights, Lambda responses, SSE metadata and the gateway responses (`UNAUTHORIZED`, `ACCESS_DENIED`, `THROTTLED`, `DEFAULT_4XX`, `DEFAULT_5XX`) name only that origin, and handlers without a valid origin name none. Stage throttling targets 10 requests per second with a burst of 20 per method; accepted turns are limited to 1/5 and SSE to 1/4, which keeps concurrent streaming functions within 33. API Gateway applies these limits per method and on a best-effort basis, and answers `429 RATE_LIMITED` with the public error shape. Reserved concurrency for SSE is off unless configured, and then must cover every stream the throttle admits.

API Gateway serves a snapshot of its configuration: preflight, gateway response and method changes reach the stage only through a new deployment. CDK derives the deployment's logical ID from the configuration as written in the template, not from the values CloudFormation resolves. The origin therefore comes from the distribution (`Fn::GetAtt`) and never from a stack parameter, an import or a dynamic reference, which a test enforces: replacing the distribution means a new logical ID, and so a new deployment. CloudFront never replaces a distribution on update, so its domain cannot change under the same logical ID. The pilot also enables `@aws-cdk/aws-apigateway:authorizerChangeDeploymentLogicalId`, so authorizer changes produce a new deployment. A value that changes outside the template leaves the stage on the old deployment. Examples: an out-of-band replacement, an imported resource, or a user pool replaced under the same logical ID, which the authorizer references by ARN. To recover, synthesize with `-c arturia:apiRedeploy=<value>`, with any value different from the previous one, and deploy again: the stage moves to a new deployment and nothing else changes. Prefer this to `aws apigateway create-deployment`, which leaves the stage outside CloudFormation.

The web client is hosted on a private S3 bucket (`arturia-pilot-web-<account>-<region>`, public access blocked, TLS only) read by CloudFront through origin access control (`infra/web-hosting.ts`). There is no custom domain: the origin is the distribution's `cloudfront.net` domain, and the CORS origin and the Cognito callback and logout URLs derive from it. A CloudFront Function serves `index.html` for paths without an extension. Files, including `/config.json`, are never rewritten, and a missing file stays a 403 from S3. Three deployments publish the Angular build and its configuration with the predefined `publisher` role:

| Deployment | Files | `Cache-Control` | Prune |
|---|---|---|---|
| Assets | `*.js`, `*.css`, `media/*` (content-hashed, checked at synthesis) | `public, max-age=31536000, immutable` | No: open tabs and rollbacks keep finding earlier chunks |
| Pages | Every other file of the build, `index.html` included | `no-cache` | Within its filter, never `config.json` |
| Configuration | `config.json`, generated from the stack (API base URL with the stage, Cognito domain and client, return URLs) | `no-store`, `application/json` | No |

The pages deployment runs after the assets, so a new `index.html` never references missing bundles, and the configuration goes last. The default cache policy has a minimum TTL of 0, so CloudFront follows each object's `Cache-Control`. `/config.json` has its own behavior with caching disabled, HTTPS only, no function, and `Cache-Control: no-store` forced on the response. 403 and 404 responses are not cached. There are no invalidations. The web bucket has a fixed name and is deleted with the stack, without an auto-delete custom resource: empty it before deleting the stack, because CloudFormation does not delete a bucket that still has objects. A response headers policy sets HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and this CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self' https://<restApiId>.execute-api.<region>.<suffix> https://<prefix>.auth.<region>.amazoncognito.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

The CSP builds the API origin from the REST API ID, never from the stage URL, which would create a dependency cycle. `'self'` covers the fetch of `/config.json`. Styles allow `'unsafe-inline'` because Angular inserts component styles at runtime and static hosting cannot issue per-response nonces. Scripts allow only `'self'`: synthesis fails if the build's `index.html` has an inline script or event handler, or ships a `config.json`.

Deployment is split into two stacks and needs no CDK bootstrap:

- **Foundation** (`infra/foundation-app.ts`, `arturia-foundation`): a private, versioned, encrypted artifact bucket with TLS enforced and a `Retain` policy, the pilot's predefined roles, the `arturia-pilot-operator` managed policy (`operatorManagedPolicy()`, to attach to a permission set) and the monthly budget. It has no assets and its template is account-agnostic. The `BudgetAlertEmail` parameter takes the alert email at deployment. It requires an administrator and the external permissions boundary `arturia-pilot-boundary`, whose document is `boundaryPolicy()`. The roles cannot exceed it.
- **Pilot** (`infra/pilot.ts`, `arturia-pilot`): the application. `CliCredentialsStackSynthesizer` uploads its assets to the foundation bucket under the `arturia-pilot/` prefix. The stack imports the foundation roles as immutable and creates no IAM resources. It is deployed with the foundation's CloudFormation role (`--role-arn`). `operatorPolicy()` lists the permissions the deploying principal needs.

`infra/delivery.ts` holds fixed resource names and the minimal policy of every role. It contains no account IDs: ARNs are built from CloudFormation pseudo parameters or from values supplied when deploying.

### Observability, retention and cost

- **Logs:** every function, the `BucketDeployment` handler included, writes to an explicit `/aws/lambda/<function>` log group with 14-day retention, JSON format, application level `INFO` and platform level `WARN`. The runtime roles cannot create log groups. The application logger records only codes, UUID identifiers and error class names. Stage access logs are off by default. `-c arturia:apiAccessLogs=true` enables them in `arturia-pilot-api-access` with a format that has no path, body, headers, identity or claims. They need the account's API Gateway CloudWatch role, which this stack never creates. Execution logging and data trace are never enabled.
- **Retention and deletion:** the table (no PITR or deletion protection), the user pool, the web bucket, the queues and the log groups are deleted with the stack. The turn queue and both DLQs keep messages for 14 days. The artifact bucket and the foundation resources are retained.
- **Alarms:** the `arturia-pilot-alerts` topic (not encrypted with the AWS managed key, which CloudWatch cannot publish to) sends alarms to the `AlertEmail` parameter, which must be confirmed from the subscription message. The single-datapoint alarms are: visible messages in each DLQ, turn DLQ age (7 days), relay `IteratorAge` (5 min), turn queue age (10 min), `Errors` of the HTTP, SSE, worker and relay functions, `Throttles` of HTTP and SSE, stage `5XXError`, and more than 2,000 requests per hour. Thresholds live in `infra/observability.ts`. A worker failure returned as `batchItemFailures` does not raise `Errors`: queue age and the DLQ catch it. SQS stops publishing metrics for a queue without activity for six hours, so the DLQ alarms keep their state when data is missing.
- **Worker kill switch:** `-c arturia:workerPaused=true` plus a deployment disables the worker's event source mapping. Messages wait in the queue (14 days) and persisted turns do not change. `false` resumes it. Any deployment without `arturia:workerPaused=true` resumes the worker: while paused, every deployment must carry the context.
- **Throughput:** the on-demand table caps read and write request units per second (`TABLE_LIMITS` in `infra/cost-controls.ts`, with the expected peak calculation).
- **Budget:** the foundation's `arturia-aws-monthly` budget (US$10 per month) filters on the `Project=arturia` cost allocation tag and emails at US$5 and US$8 of actual spend and US$10 forecasted. It excludes credits and refunds. It has no actions: it alerts with billing delay and never stops spending. The tag must be activated as a cost allocation tag before the budget sees it, and charges that cannot be tagged fall outside the filter. The App tags resources with `Project` and `Environment`.

## Model egress and accounting

Billable workers use `dispatchModel`. Chat uses `createTurnDispatcher` to read the current account, session, scope, turn lease, message and source grants in one DynamoDB snapshot. Each provider needs an enabled scope grant with explicit origins, categories and integrations. Derived sources also require current source access. An unresolved source, detected secret or identified banking material blocks the request.

One DynamoDB table owns the deployment budget. Each attempt reserves against both the US$10 UTC calendar-month ceiling and the configured provider ceiling. Amounts use integer microdollars (1 USD = 1,000,000 µUSD). Token rates use µUSD per million tokens, with one upward rounding after summing all token costs. The transport supplies a verified upper bound for the entire encoded input and enforces limits for visible output, reasoning, tool arguments and separately billed tool calls. Token buckets are disjoint. Missing or expired prices disable new sends.

The ledger records the applied tariff, provider, model, operation, usage and cost. Redelivery cannot reuse a reservation. A confirmed final usage report or invoice reconciles the original month exactly once. A timeout, interrupted stream or missing report retains the full reservation for reconciliation. Each subsequent authorized attempt needs a new ID. A transport must disable implicit retries.

## Operator scripts

`src/admin/` holds the administrative operations of the pilot. Both scripts compile first and print one JSON line. The Cognito subject is masked in the output. A synthetic identity mode or an SDK endpoint override aborts the script. Commands that touch the table require `--table`, `--region`, `--profile` and `--expected-account`. Before any data access, they confirm the account and region from the table ARN.

| Command | Purpose |
| --- | --- |
| `npm run provision:pilot -- --sub <sub>` | Dry run. Lists the rows it would ensure without reading or writing anything. |
| `... --check <target>` | Read-only. Reports `absent`, `partial`, `complete` or `conflict`, plus the presence of model grants. Exits with 2 unless the state is complete. |
| `... --apply --confirm-totp-enrolled <target>` | Creates the missing `SUBJECT`, `ACCOUNT` (active, `mfaVerifiedAt` = now + 60 s, a margin against a local clock behind AWS) and the `personal` and `work` `SCOPE` rows in one transaction. Existing rows are never modified. A disabled account, different scope actions or an invalid mapping stop the run before any write. Model grants are never written. |
| `npm run republish:outbox -- --sub <sub> <target>` | Read-only listing of the user's pending outbox intents (`--scope` narrows it). |
| `... --apply --queue-url <url>` | Publishes each pending intent to the FIFO turn queue (`*turns.fifo`, never the dead-letter queue) of the same account and region, then marks it. Stops at the first failure and leaves the rest pending. A duplicate is harmless: the worker claims the durable turn by ID. |

After `--apply`, wait more than a minute and sign in again: sessions authenticated before `mfaVerifiedAt` are rejected. Messages in the turn dead-letter queue already have a published outbox row and are recovered with an SQS redrive to the turn queue, not with `republish:outbox`. The relay dead-letter queue holds stream batch metadata only; its turns are recovered with `republish:outbox`.

## Local development

Use the Node.js version in `.nvmrc` and install dependencies with `npm ci`.

| Command | Purpose |
| --- | --- |
| `npm run verify` | Validate contracts, run unit and infrastructure tests, and build TypeScript. |
| `npm run test:integration` | Run persistence tests with Docker and Docker Compose. |
| `npm run verify:local` | Run verification and the local persistence suite. |
| `ARTURIA_WEB_DIR=../arturia npm run verify:integrated` | Run the Angular + API chat scenarios with Chromium and DynamoDB Local on Linux. |
| `npm run bundle` | Build the Lambda bundles into `dist/bundles/`. |
| `npm run synth` | Test synthesis into `cdk.out/`: synthetic account, placeholder bundles, stack `arturia-pilot-synthetic` and output `SyntheticSynth=true`. Not deployable. |
| `npm run synth:foundation` | Synthesize the foundation into `cdk.foundation.out/`. |
| `ARTURIA_WEB_DIR=../arturia npm run synth:pilot -- -c arturia:account=<id> -c arturia:region=<region>` | Build the bundles and synthesize the deployable pilot into `cdk.pilot.out/`. Fails without the account, the region, the web checkout or its production build (`npm run build` in the web checkout). Add `-c arturia:apiRedeploy=<value>` only to force a new API Gateway deployment. |

Integration tests start an isolated DynamoDB Local instance on a temporary loopback port with synthetic credentials. Docker may download the pinned image on first use. The suite removes its container, in-memory data, and network on exit. Each execution gets its own table. To select an integration file or scenario, use `npm run test:integration -- dynamodb` or `npm run test:integration -- -t local_dynamodb_conditional_write`.

Install both checkouts with `npm ci` and install Chromium in the web checkout with `npm exec -- playwright install chromium`. The integrated suite uses separate loopback origins and enforces the contract digest in `scripts/integrated-scenarios.json`.

## License

Copyright © 2026 Matias Galeano ([matigaleanodev](https://github.com/matigaleanodev)), original author. The source is licensed under the [Mozilla Public License 2.0](LICENSE).
