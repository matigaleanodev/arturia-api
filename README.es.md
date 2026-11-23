# Arturia API

[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/docs/latest-v24.x/api/)
[![TypeScript 6.0](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
[![AWS CDK 2](https://img.shields.io/badge/AWS%20CDK-2-FF9900)](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[English](README.md)

Backend de Arturia, un asistente personal con conversaciones organizadas por usuario y ámbito. El [contrato HTTP](contracts/openapi.json) y el [esquema SSE](contracts/sse.schema.json) definen la interfaz del cliente web. La infraestructura AWS CDK vive en `infra/`.

Los títulos de conversación y los textos de mensajes admiten hasta 393.216 bytes UTF-8 cada uno. Los identificadores de ámbito, conversación y turno en las rutas admiten hasta 256 bytes UTF-8 cada uno. Los valores que exceden estos límites reciben HTTP 400 con código `INVALID_REQUEST`.

El endpoint de eventos del turno admite el cursor opcional `after`, un entero mayor o igual que cero. Lee bloques persistidos, comprueba la sesión y el permiso de ámbito antes de cada lote y cierra tras el estado terminal, la revocación o el límite de tiempo de la conexión. Para reanudar, enviá la última secuencia de texto recibida. Los comentarios de latido carecen de datos.

`addChatStream` compone el handler de entrega con la tabla de chat, el pool de Cognito y el ID del cliente web. El construct expone su REST API regional para agregar rutas. La entrega requiere una sesión de Arturia existente y tiene concurrencia reservada independiente.

## Infraestructura

`npm run bundle` genera un bundle autocontenido para Node.js 24 por cada handler Lambda en `dist/bundles/<nombre>/index.cjs`. `BUNDLES` en `infra/delivery.ts` enumera los puntos de entrada, que deben estar en `src/`.

El despliegue se divide en dos stacks y no requiere bootstrap de CDK:

- **Fundación** (`infra/foundation-app.ts`, `arturia-foundation`): bucket de artefactos privado, versionado, cifrado, con TLS obligatorio y política `Retain`, más los roles predefinidos del piloto. No tiene assets y su plantilla no depende de la cuenta. Requiere un administrador y la boundary externa `arturia-pilot-boundary`, cuyo documento es `boundaryPolicy()`. Los roles no pueden excederla.
- **Piloto** (`infra/pilot.ts`, `arturia-pilot`): la aplicación. `CliCredentialsStackSynthesizer` sube sus assets al bucket de la fundación con el prefijo `arturia-pilot/`. El stack importa los roles de la fundación como inmutables y no crea recursos IAM. Se despliega con el rol de CloudFormation de la fundación (`--role-arn`). `operatorPolicy()` enumera los permisos que necesita el principal que despliega.

`infra/delivery.ts` contiene los nombres fijos de los recursos y la política mínima de cada rol. No incluye IDs de cuenta: los ARN se construyen con pseudoparámetros de CloudFormation o con valores provistos al desplegar.

## Envíos a modelos y presupuesto

Los trabajos facturables usan `dispatchModel`. El chat usa `createTurnDispatcher` para leer en una sola transacción de DynamoDB la cuenta, sesión, ámbito, lease del turno, mensaje y permisos de las fuentes. Cada proveedor requiere autorización activa en el ámbito con orígenes, categorías e integraciones explícitos. Los derivados también requieren acceso vigente a la fuente. Una fuente sin resolver, un secreto detectado o material identificado como bancario bloquean el envío.

Una tabla DynamoDB contiene el presupuesto del despliegue. Cada intento reserva contra el tope de US$10 por mes calendario UTC y el tope configurable del proveedor. La unidad es el microdólar entero (1 USD = 1.000.000 µUSD). Las tarifas por millón de tokens se expresan en µUSD y se redondea hacia arriba una sola vez tras sumar los cargos por tokens. El transporte provee una cota verificada para la entrada codificada completa e impone límites para salida visible, razonamiento, argumentos de herramientas y llamadas con cargo independiente. Cada token pertenece a una sola categoría. La ausencia o el vencimiento de una tarifa impide nuevos envíos.

El registro conserva tarifa, proveedor, modelo, operación, uso y costo. La reentrega del trabajo no permite reutilizar una reserva. El reporte de uso final confirmado o la factura concilian una sola vez el mes original. Un timeout, un stream interrumpido o la falta de reporte conservan la reserva completa hasta conciliarla. Cada nuevo intento autorizado requiere otro ID. El transporte debe desactivar los reintentos implícitos.

## Desarrollo local

Usá la versión de Node.js de `.nvmrc` e instalá las dependencias con `npm ci`.

| Comando | Propósito |
| --- | --- |
| `npm run verify` | Valida contratos, ejecuta pruebas unitarias y de infraestructura, y compila TypeScript. |
| `npm run test:integration` | Ejecuta pruebas de persistencia con Docker y Docker Compose. |
| `npm run verify:local` | Ejecuta la verificación y la suite de persistencia local. |
| `ARTURIA_WEB_DIR=../arturia npm run verify:integrated` | Ejecuta los escenarios de chat de Angular y la API con Chromium y DynamoDB Local en Linux. |
| `npm run bundle` | Genera los bundles Lambda en `dist/bundles/`. |
| `npm run synth` | Síntesis de prueba en `cdk.out/`: cuenta sintética, bundles de reemplazo, stack `arturia-pilot-synthetic` y salida `SyntheticSynth=true`. No es desplegable. |
| `npm run synth:foundation` | Sintetiza la fundación en `cdk.foundation.out/`. |
| `ARTURIA_WEB_DIR=../arturia npm run synth:pilot -- -c arturia:account=<id> -c arturia:region=<región>` | Genera los bundles y sintetiza el piloto desplegable en `cdk.pilot.out/`. Falla sin la cuenta, la región o el checkout web. |

Las pruebas de integración inician una instancia aislada de DynamoDB Local en un puerto local temporal, con credenciales sintéticas. Docker puede descargar la imagen fijada en el primer uso. La suite elimina el contenedor, los datos en memoria y la red al terminar. Cada ejecución tiene su propia tabla. Para elegir un archivo o escenario de integración, usá `npm run test:integration -- dynamodb` o `npm run test:integration -- -t local_dynamodb_conditional_write`.

Instalá las dependencias de ambos repositorios con `npm ci` y Chromium en el frontend con `npm exec -- playwright install chromium`. La suite integrada usa dos orígenes loopback y verifica el digest del contrato en `scripts/integrated-scenarios.json`.

## Licencia

Copyright © 2026 Matias Galeano ([matigaleanodev](https://github.com/matigaleanodev)), autor original. El código fuente se distribuye bajo la [Mozilla Public License 2.0](LICENSE).
