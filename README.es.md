# Arturia API

[![CI](https://github.com/matigaleanodev/arturia-api/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/matigaleanodev/arturia-api/actions/workflows/ci.yml)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
[![AWS CDK 2](https://img.shields.io/badge/AWS%20CDK-2-FF9900)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[English](README.md)

Arturia es una base de código abierto para construir tu propio asistente personal. Este repositorio contiene la API serverless y la infraestructura en AWS para organizar conversaciones por usuario y ámbito.

## Características

- Creá, listá y leé conversaciones por usuario y ámbito.
- Enviá, leé y cancelá turnos de chat. Recibí respuestas por SSE y retomá la lectura después de una desconexión.
- Autenticación con Cognito, MFA TOTP obligatorio y revalidación de la sesión.
- Generación con modelos de OpenAI, con modos sintéticos que omiten las llamadas al proveedor.
- Límites mensuales de gasto en modelos y conciliación con facturas o informes de uso del proveedor.
- Hosting privado del cliente web en S3 mediante CloudFront, con alertas y herramientas de recuperación para operadores.

## Stack tecnológico

TypeScript sobre Node.js 24, AWS CDK v2, Lambda, API Gateway REST, DynamoDB, SQS FIFO, Cognito, S3 y CloudFront. Las pruebas usan Vitest y DynamoDB Local.

## Primeros pasos

Usá la versión de Node.js indicada en [`.nvmrc`](.nvmrc) y npm. Las pruebas de integración de persistencia también requieren Docker y Docker Compose.

```bash
npm ci
npm run verify
npm run synth
```

Estos comandos verifican el código y generan localmente una plantilla de prueba. Consultá [Pruebas](docs/testing.es.md) para ejecutar la suite integrada de chat y `npm run verify:local` con DynamoDB Local. Para usar la API en AWS, seguí la guía de [Despliegue](docs/deployment.es.md).

## Documentación

- [Arquitectura](docs/architecture.es.md)
- [Infraestructura](docs/infrastructure.es.md)
- [Despliegue](docs/deployment.es.md)
- [Seguridad](docs/security.es.md)
- [Control de costos](docs/cost-controls.es.md)
- [Operación](docs/operations.es.md)
- [Pruebas](docs/testing.es.md)

## Repositorio complementario

[Arturia](https://github.com/matigaleanodev/arturia) es el cliente web en Angular.

## Autoría y licencia

Mantenido por [Matías Galeano](https://github.com/matigaleanodev). Distribuido bajo la [Mozilla Public License 2.0 (MPL-2.0)](LICENSE). Copyright © 2026 Matias Galeano, autor original.
