# Arturia API

[![CI](https://github.com/matigaleanodev/arturia-api/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/matigaleanodev/arturia-api/actions/workflows/ci.yml)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
[![AWS CDK 2](https://img.shields.io/badge/AWS%20CDK-2-FF9900)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[Español](README.es.md)

Arturia is an open-source starting point for building your own personal assistant. This repository contains the serverless API and AWS infrastructure for conversations organized by user and scope.

## Features

- Create, list and read conversations by user and scope.
- Submit, read and cancel chat turns. Stream responses over SSE and resume after a disconnect.
- Cognito authentication with mandatory TOTP MFA and session revalidation.
- OpenAI model generation, with synthetic modes that skip provider calls.
- Monthly model spend limits and reconciliation against provider invoices or usage reports.
- Private S3 hosting for the web client through CloudFront, with alerts and recovery tools for operators.

## Tech stack

TypeScript on Node.js 24, AWS CDK v2, Lambda, API Gateway REST, DynamoDB, SQS FIFO, Cognito, S3 and CloudFront. Tests use Vitest and DynamoDB Local.

## Getting started

Use the Node.js version in [`.nvmrc`](.nvmrc) and npm. Persistence integration tests also require Docker and Docker Compose.

```bash
npm ci
npm run verify
npm run synth
```

These commands verify the code and synthesize a test template locally. See [Testing](docs/testing.md) for the integrated chat suite and `npm run verify:local` with DynamoDB Local. To run the API on AWS, follow [Deployment](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Infrastructure](docs/infrastructure.md)
- [Deployment](docs/deployment.md)
- [Security](docs/security.md)
- [Cost controls](docs/cost-controls.md)
- [Operations](docs/operations.md)
- [Testing](docs/testing.md)

## Companion repository

[Arturia](https://github.com/matigaleanodev/arturia) is the Angular web client.

## Author and license

Maintained by [Matías Galeano](https://github.com/matigaleanodev). Licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE). Copyright © 2026 Matias Galeano, original author.
