# Pruebas

[English](testing.md)

Usá la versión de Node.js de `.nvmrc` e instalá las dependencias con `npm ci`. Las pruebas usan datos e identidades sintéticas.

## Comandos

| Comando | Propósito |
| --- | --- |
| `npm run verify` | Valida contratos, ejecuta pruebas unitarias y de infraestructura, y compila TypeScript. |
| `npm run verify:local` | Ejecuta `verify` y la suite de persistencia local. |
| `npm test` | Pruebas de contrato, unitarias y de infraestructura, sin el build. |
| `npm run test:contract` | Valida [`contracts/`](../contracts/) y sus fixtures. |
| `npm run test:unit` | Proyecto Vitest `unit` (`src/**/*.spec.ts`, `tests/unit/`). |
| `npm run test:infra` | Proyecto Vitest `infra` (`infra/**/*.spec.ts`). `verify` lo ejecuta después de `build`. |
| `npm run test:integration` | Proyecto Vitest `integration` con Docker y Docker Compose. |
| `ARTURIA_WEB_DIR=../arturia npm run verify:integrated` | Escenarios de chat de Angular y la API con Chromium y DynamoDB Local en Linux. |
| `npm run build` | Verifica tipos, compila y genera los bundles Lambda. |
| `npm run bundle` | Genera los bundles Lambda en `dist/bundles/`. |
| `npm run synth` | Síntesis CDK sintética en `cdk.out/` (no desplegable). |

Los proyectos de Vitest se definen en [`vitest.config.ts`](../vitest.config.ts). Los filtros van después de `--`.

## Pruebas de integración

Las pruebas de integración inician una instancia aislada de DynamoDB Local ([`compose.test.yml`](../compose.test.yml)) en un puerto loopback temporal, con credenciales sintéticas. Docker puede descargar la imagen fijada en el primer uso. La suite elimina el contenedor, los datos en memoria y la red al terminar, y cada ejecución tiene su propia tabla.

Para elegir un archivo o escenario: `npm run test:integration -- dynamodb` o `npm run test:integration -- -t local_dynamodb_conditional_write`.

## Suite integrada

Instalá las dependencias de ambos checkouts con `npm ci` y Chromium en el checkout web con `npm exec -- playwright install chromium`. En Linux, si faltan las bibliotecas del sistema que necesita el navegador, usá `npm exec -- playwright install --with-deps chromium`. La suite usa orígenes loopback separados y verifica el digest del contrato en [`scripts/integrated-scenarios.json`](../scripts/integrated-scenarios.json).

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) ejecuta `npm ci`, `npm run verify` y `npm run synth` en pull requests y pushes a `dev` y `main`. [`.github/workflows/branch-policy.yml`](../.github/workflows/branch-policy.yml) verifica los nombres de rama en los pull requests.
