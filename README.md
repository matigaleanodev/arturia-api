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
| `http` | REST proxy for conversations and turns (`src/http/turns.lambda.ts`). The actor comes only from the Cognito authorizer claims for this app client with the `arturia/access` scope, and the session is revalidated in DynamoDB. | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID` |
| `worker` | SQS consumer of turns (`src/chat/generate.lambda.ts`). `retry`, invalid messages and failures become `batchItemFailures`; in a FIFO batch the remaining messages are returned unprocessed. | `ARTURIA_TABLE_NAME`, `ARTURIA_ENVIRONMENT`, `ARTURIA_PROVIDER_MODE` |
| `stream` | SSE turn events in streaming mode. | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID` |
| `relay` | DynamoDB stream outbox relay to SQS. | `ARTURIA_TABLE_NAME`, `ARTURIA_TURN_QUEUE_URL` |

The `http` and `worker` handlers read and validate their configuration once per execution environment. An invalid configuration fails closed: HTTP answers `500 INTERNAL_ERROR` with the public error shape, and the worker fails the invocation so every message returns to the queue. `ARTURIA_PROVIDER_MODE` currently accepts only the non-billable pilot fixtures, and only with `ARTURIA_ENVIRONMENT=pilot`: `fixture` emits three synthetic blocks one second apart, and `fail` never runs the turn so the message reaches the dead-letter queue. Logs are structured JSON with a code, UUID identifiers, HTTP status and error class only, never message text, prompts, claims or secrets.

Worker durations live in `src/config/timing.ts`, shared by the code and the CDK composition, and are validated at synthesis: provider timeout (45 s) plus a closing margin is below the worker timeout (60 s), which the turn lease (75 s) covers, and the `TurnQueue` visibility (360 s, six times the function timeout) exceeds worker timeout plus lease, so a redelivery always finds an expired lease. The event source delivers one message per invocation with partial batch responses and a maximum concurrency of 2, instead of reserved concurrency. Messages are retained for 14 days and move to the FIFO dead-letter queue after 5 receives. A redelivered turn whose send crossed the provider boundary ends as `SEND_UNCERTAIN` and is never sent or reserved again. The message group is a hash of user and scope: a retried turn holds back later turns of the same user and scope for the whole visibility, never those of another scope or user.

Deployment is split into two stacks and needs no CDK bootstrap:

- **Foundation** (`infra/foundation-app.ts`, `arturia-foundation`): a private, versioned, encrypted artifact bucket with TLS enforced and a `Retain` policy, plus the pilot's predefined roles. It has no assets and its template is account-agnostic. It requires an administrator and the external permissions boundary `arturia-pilot-boundary`, whose document is `boundaryPolicy()`. The roles cannot exceed it.
- **Pilot** (`infra/pilot.ts`, `arturia-pilot`): the application. `CliCredentialsStackSynthesizer` uploads its assets to the foundation bucket under the `arturia-pilot/` prefix. The stack imports the foundation roles as immutable and creates no IAM resources. It is deployed with the foundation's CloudFormation role (`--role-arn`). `operatorPolicy()` lists the permissions the deploying principal needs.

`infra/delivery.ts` holds fixed resource names and the minimal policy of every role. It contains no account IDs: ARNs are built from CloudFormation pseudo parameters or from values supplied when deploying.

## Model egress and accounting

Billable workers use `dispatchModel`. Chat uses `createTurnDispatcher` to read the current account, session, scope, turn lease, message and source grants in one DynamoDB snapshot. Each provider needs an enabled scope grant with explicit origins, categories and integrations. Derived sources also require current source access. An unresolved source, detected secret or identified banking material blocks the request.

One DynamoDB table owns the deployment budget. Each attempt reserves against both the US$10 UTC calendar-month ceiling and the configured provider ceiling. Amounts use integer microdollars (1 USD = 1,000,000 µUSD). Token rates use µUSD per million tokens, with one upward rounding after summing all token costs. The transport supplies a verified upper bound for the entire encoded input and enforces limits for visible output, reasoning, tool arguments and separately billed tool calls. Token buckets are disjoint. Missing or expired prices disable new sends.

The ledger records the applied tariff, provider, model, operation, usage and cost. Redelivery cannot reuse a reservation. A confirmed final usage report or invoice reconciles the original month exactly once. A timeout, interrupted stream or missing report retains the full reservation for reconciliation. Each subsequent authorized attempt needs a new ID. A transport must disable implicit retries.

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
| `ARTURIA_WEB_DIR=../arturia npm run synth:pilot -- -c arturia:account=<id> -c arturia:region=<region>` | Build the bundles and synthesize the deployable pilot into `cdk.pilot.out/`. Fails without the account, region or web checkout. |

Integration tests start an isolated DynamoDB Local instance on a temporary loopback port with synthetic credentials. Docker may download the pinned image on first use. The suite removes its container, in-memory data, and network on exit. Each execution gets its own table. To select an integration file or scenario, use `npm run test:integration -- dynamodb` or `npm run test:integration -- -t local_dynamodb_conditional_write`.

Install both checkouts with `npm ci` and install Chromium in the web checkout with `npm exec -- playwright install chromium`. The integrated suite uses separate loopback origins and enforces the contract digest in `scripts/integrated-scenarios.json`.

## License

Copyright © 2026 Matias Galeano ([matigaleanodev](https://github.com/matigaleanodev)), original author. The source is licensed under the [Mozilla Public License 2.0](LICENSE).
