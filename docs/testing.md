# Testing

[Español](testing.es.md)

Use the Node.js version in `.nvmrc` and install dependencies with `npm ci`. Tests use synthetic data and identities.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run verify` | Validate contracts, run unit and infrastructure tests, and build TypeScript. |
| `npm run verify:local` | Run `verify` and the local persistence suite. |
| `npm test` | Contract, unit and infrastructure tests, without the build. |
| `npm run test:contract` | Validate [`contracts/`](../contracts/) and its fixtures. |
| `npm run test:unit` | Vitest `unit` project (`src/**/*.spec.ts`, `tests/unit/`). |
| `npm run test:infra` | Vitest `infra` project (`infra/**/*.spec.ts`). `verify` runs it after `build`. |
| `npm run test:integration` | Vitest `integration` project with Docker and Docker Compose. |
| `ARTURIA_WEB_DIR=../arturia npm run verify:integrated` | Angular + API chat scenarios with Chromium and DynamoDB Local on Linux. |
| `npm run build` | Type-check, compile and build the Lambda bundles. |
| `npm run bundle` | Build the Lambda bundles into `dist/bundles/`. |
| `npm run synth` | Synthetic CDK synthesis into `cdk.out/` (not deployable). |

Vitest projects are defined in [`vitest.config.ts`](../vitest.config.ts). Add filters after `--`.

## Integration tests

Integration tests start an isolated DynamoDB Local instance ([`compose.test.yml`](../compose.test.yml)) on a temporary loopback port with synthetic credentials. Docker may download the pinned image on first use. The suite removes its container, in-memory data and network on exit, and each execution gets its own table.

To select a file or scenario: `npm run test:integration -- dynamodb` or `npm run test:integration -- -t local_dynamodb_conditional_write`.

## Integrated suite

Install both checkouts with `npm ci` and install Chromium in the web checkout with `npm exec -- playwright install chromium`. On Linux without the browser’s system libraries, use `npm exec -- playwright install --with-deps chromium`. The suite uses separate loopback origins and enforces the contract digest in [`scripts/integrated-scenarios.json`](../scripts/integrated-scenarios.json).

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `npm ci`, `npm run verify` and `npm run synth` on pull requests and pushes to `dev` and `main`. [`.github/workflows/branch-policy.yml`](../.github/workflows/branch-policy.yml) checks branch names on pull requests.
