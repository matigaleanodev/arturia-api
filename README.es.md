# Arturia API

[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
[![AWS CDK 2](https://img.shields.io/badge/AWS%20CDK-2-FF9900)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[English](README.md)

Backend de Arturia, un asistente personal con conversaciones organizadas por usuario y ámbito. El [contrato HTTP](contracts/openapi.json) y el [esquema SSE](contracts/sse.schema.json) definen la interfaz del cliente web. La infraestructura AWS CDK vive en `infra/`.

Los títulos de conversación y los textos de mensajes admiten hasta 393.216 bytes UTF-8 cada uno. Los identificadores de ámbito, conversación y turno en las rutas admiten hasta 256 bytes UTF-8 cada uno. Los valores que exceden estos límites reciben HTTP 400 con código `INVALID_REQUEST`.

## Desarrollo local

Usá la versión de Node.js de `.nvmrc` e instalá las dependencias con `npm ci`.

| Comando | Propósito |
| --- | --- |
| `npm run verify` | Valida contratos, ejecuta pruebas unitarias y de infraestructura, y compila TypeScript. |
| `npm run test:integration` | Ejecuta pruebas de persistencia con Docker y Docker Compose. |
| `npm run verify:local` | Ejecuta la verificación y la suite de persistencia local. |
| `ARTURIA_WEB_DIR=../arturia npm run verify:integrated` | Ejecuta los escenarios de chat de Angular y la API con Chromium y DynamoDB Local en Linux. |
| `npm run synth` | Sintetiza el stack CDK en `cdk.out/` con los lookups de AWS desactivados. |

Las pruebas de integración inician una instancia aislada de DynamoDB Local en un puerto local temporal, con credenciales sintéticas. Docker puede descargar la imagen fijada en el primer uso. La suite elimina el contenedor, los datos en memoria y la red al terminar. Cada ejecución tiene su propia tabla. Para elegir un archivo o escenario de integración, usá `npm run test:integration -- dynamodb` o `npm run test:integration -- -t local_dynamodb_conditional_write`.

Instalá las dependencias de ambos repositorios con `npm ci` y Chromium en el frontend con `npm exec -- playwright install chromium`. La suite integrada usa dos orígenes loopback y verifica el digest del contrato en `scripts/integrated-scenarios.json`.

## Licencia

Copyright © 2026 Matias Galeano ([matigaleanodev](https://github.com/matigaleanodev)), autor original. El código fuente se distribuye bajo la [Mozilla Public License 2.0](LICENSE).
