# Arturia API

[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
[![AWS CDK 2](https://img.shields.io/badge/AWS%20CDK-2-FF9900)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[Español](README.es.md)

Backend for Arturia, a personal assistant with conversations organized by user and scope. The [HTTP contract](contracts/openapi.json) and [SSE schema](contracts/sse.schema.json) define the web client interface. AWS CDK infrastructure lives in `infra/`.

Conversation titles and message text each accept up to 393,216 UTF-8 bytes. Scope, conversation, and turn IDs in paths accept up to 256 UTF-8 bytes each. Oversized values return HTTP 400 with code `INVALID_REQUEST`.

The turn events endpoint accepts an optional nonnegative integer `after` cursor. It reads persisted blocks, rechecks the current session and scope grant before each batch, and closes after the terminal status, revocation, or the connection time limit. Reconnect with the last text sequence received. Heartbeat comments carry no data.

`npm run bundle:stream` builds the Node.js 24 delivery handler in `dist/stream/`. Pass that directory to `lambda.Code.fromAsset` when composing `addChatStream` with the chat table, Cognito pool and browser client ID. The construct exposes its Regional REST API for additional routes. Delivery requires an existing Arturia session and has independent reserved concurrency.

## Local development

Use the Node.js version in `.nvmrc` and install dependencies with `npm ci`.

| Command | Purpose |
| --- | --- |
| `npm run verify` | Validate contracts, run unit and infrastructure tests, and build TypeScript. |
| `npm run test:integration` | Run persistence tests with Docker and Docker Compose. |
| `npm run verify:local` | Run verification and the local persistence suite. |
| `ARTURIA_WEB_DIR=../arturia npm run verify:integrated` | Run the Angular + API chat scenarios with Chromium and DynamoDB Local on Linux. |
| `npm run synth` | Synthesize the CDK stack locally into `cdk.out/` with AWS lookups disabled. |

Integration tests start an isolated DynamoDB Local instance on a temporary loopback port with synthetic credentials. Docker may download the pinned image on first use. The suite removes its container, in-memory data, and network on exit. Each execution gets its own table. To select an integration file or scenario, use `npm run test:integration -- dynamodb` or `npm run test:integration -- -t local_dynamodb_conditional_write`.

Install both checkouts with `npm ci` and install Chromium in the web checkout with `npm exec -- playwright install chromium`. The integrated suite uses separate loopback origins and enforces the contract digest in `scripts/integrated-scenarios.json`.

## License

Copyright © 2026 Matias Galeano ([matigaleanodev](https://github.com/matigaleanodev)), original author. The source is licensed under the [Mozilla Public License 2.0](LICENSE).
