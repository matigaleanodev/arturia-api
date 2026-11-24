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

| Bundle | Handler | Configuración |
|---|---|---|
| `http` | Proxy REST de conversaciones y turnos (`src/http/turns.lambda.ts`). El actor sale solo de los claims del authorizer de Cognito para este cliente de la app con el scope `arturia/access`, y la sesión se revalida en DynamoDB. | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID`, `ARTURIA_ALLOWED_ORIGIN` |
| `worker` | Consumidor SQS de turnos (`src/chat/generate.lambda.ts`). `retry`, los mensajes inválidos y los fallos se devuelven como `batchItemFailures`; en un lote FIFO, los mensajes restantes se devuelven sin procesar. | `ARTURIA_TABLE_NAME`, `ARTURIA_ENVIRONMENT`, `ARTURIA_PROVIDER_MODE` |
| `stream` | Eventos SSE del turno en modo streaming. | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID`, `ARTURIA_ALLOWED_ORIGIN` |
| `relay` | Relay del outbox desde el stream de DynamoDB hacia SQS. | `ARTURIA_TABLE_NAME`, `ARTURIA_TURN_QUEUE_URL` |

Los handlers `http` y `worker` leen y validan su configuración una vez por entorno de ejecución. Una configuración inválida falla cerrada: HTTP responde `500 INTERNAL_ERROR` con la forma pública de error y el worker hace fallar la invocación para que todos los mensajes vuelvan a la cola. Por ahora, `ARTURIA_PROVIDER_MODE` acepta solo los fixtures no facturables del piloto, y únicamente con `ARTURIA_ENVIRONMENT=pilot`: `fixture` emite tres bloques sintéticos separados por un segundo y `fail` nunca ejecuta el turno, de modo que el mensaje llega a la cola de mensajes fallidos. Los logs son JSON estructurado con código, identificadores UUID, estado HTTP y clase de error, nunca texto de mensajes, prompts, claims ni secretos.

Las duraciones del worker están en `src/config/timing.ts`, compartido por el código y la composición CDK, y se validan al sintetizar: el timeout del proveedor (45 s) más un margen de cierre es menor que el timeout del worker (60 s), que el lease del turno (75 s) cubre, y la visibilidad de `TurnQueue` (360 s, seis veces el timeout de la función) supera la suma del timeout del worker y el lease, de modo que una reentrega siempre encuentra el lease vencido. La fuente de eventos entrega un mensaje por invocación con respuestas parciales de lote y concurrencia máxima 2, en lugar de concurrencia reservada. Los mensajes se retienen 14 días y pasan a la cola FIFO de mensajes fallidos tras 5 recepciones. Un turno reentregado cuyo envío cruzó el límite del proveedor termina como `SEND_UNCERTAIN` y nunca se reenvía ni vuelve a reservar presupuesto. El grupo de mensajes es un hash de usuario y ámbito: un turno reintentado retiene los turnos siguientes del mismo usuario y ámbito durante toda la visibilidad, nunca los de otro ámbito o usuario.

Una sola API REST Regional (`infra/chat-api.ts`) atiende todas las rutas del contrato, enumeradas una vez en `src/http/routes.ts`. Todas exigen el authorizer de Cognito con el scope `arturia/access`; solo los preflight de CORS son anónimos. La ruta SSE invoca la función `stream` con response streaming y un timeout de integración de 29 s, menor que el límite de 15 minutos del streaming en APIs REST; los clientes se reconectan con el cursor `after`. CORS admite un único origen HTTPS exacto, el dominio de la distribución web derivado dentro del stack piloto, sin credenciales: los preflight, las respuestas de Lambda, los metadatos SSE y las gateway responses (`UNAUTHORIZED`, `ACCESS_DENIED`, `THROTTLED`, `DEFAULT_4XX`, `DEFAULT_5XX`) nombran solo ese origen, y un handler sin origen válido no nombra ninguno. El throttling del stage apunta a 10 solicitudes por segundo con ráfaga de 20 por método; los turnos aceptados se limitan a 1/5 y SSE a 1/4, lo que mantiene las funciones de streaming concurrentes en 33 como máximo. API Gateway aplica estos límites por método y como mejor esfuerzo, y responde `429 RATE_LIMITED` con la forma pública de error. La concurrencia reservada de SSE está desactivada salvo que se configure, y en ese caso debe cubrir todos los streams que admite el throttling.

API Gateway sirve una instantánea de su configuración: los cambios de preflight, gateway responses y métodos llegan al stage solo con un deployment nuevo. CDK deriva el ID lógico del deployment de la configuración tal como está escrita en la plantilla, no de los valores que resuelve CloudFormation. Por eso el origen sale de la distribución (`Fn::GetAtt`) y nunca de un parámetro del stack, un import o una referencia dinámica, cosa que una prueba verifica: reemplazar la distribución implica un ID lógico nuevo y, con él, un deployment nuevo. CloudFront nunca reemplaza una distribución al actualizarla, así que su dominio no puede cambiar con el mismo ID lógico. El piloto activa además `@aws-cdk/aws-apigateway:authorizerChangeDeploymentLogicalId`, para que los cambios del authorizer generen un deployment nuevo. Un valor que cambia fuera de la plantilla deja el stage en el deployment anterior. Por ejemplo: un reemplazo manual, un recurso importado o un user pool reemplazado con el mismo ID lógico, que el authorizer referencia por ARN. Para recuperarlo, sintetizá con `-c arturia:apiRedeploy=<valor>`, con cualquier valor distinto del anterior, y volvé a desplegar: el stage pasa a un deployment nuevo y no cambia nada más. Es preferible a `aws apigateway create-deployment`, que deja el stage fuera de CloudFormation.

El cliente web se aloja en un bucket S3 privado (`arturia-pilot-web-<cuenta>-<región>`, acceso público bloqueado, solo TLS) que CloudFront lee mediante origin access control (`infra/web-hosting.ts`). No hay dominio propio: el origen es el dominio `cloudfront.net` de la distribución, y de él se derivan el origen de CORS y las URL de callback y logout de Cognito. Una CloudFront Function sirve `index.html` en las rutas sin extensión. Los archivos, incluido `/config.json`, nunca se reescriben, y un archivo faltante queda como un 403 de S3. Tres deployments publican el build de Angular y su configuración con el rol predefinido `publisher`:

| Deployment | Archivos | `Cache-Control` | Prune |
|---|---|---|---|
| Assets | `*.js`, `*.css`, `media/*` (con hash de contenido, verificado al sintetizar) | `public, max-age=31536000, immutable` | No: las pestañas abiertas y los rollbacks siguen encontrando los chunks anteriores |
| Páginas | El resto del build, incluido `index.html` | `no-cache` | Dentro de su filtro, nunca `config.json` |
| Configuración | `config.json`, generado desde el stack (URL base de la API con el stage, dominio y cliente de Cognito, URL de retorno) | `no-store`, `application/json` | No |

El deployment de páginas corre después del de assets, para que un `index.html` nuevo nunca referencie bundles ausentes, y la configuración va al final. La política de caché por defecto tiene TTL mínimo 0, así que CloudFront respeta el `Cache-Control` de cada objeto. `/config.json` tiene un comportamiento propio con la caché desactivada, solo HTTPS, sin función y con `Cache-Control: no-store` forzado en la respuesta. Las respuestas 403 y 404 no se cachean. No hay invalidaciones. El bucket web conserva la política `Retain` por defecto de CDK y un nombre fijo: después de eliminar el stack, vaciá y eliminá el bucket antes de volver a crearlo. Una response headers policy define HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y esta CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self' https://<restApiId>.execute-api.<región>.<sufijo> https://<prefijo>.auth.<región>.amazoncognito.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

La CSP arma el origen de la API con el ID de la API REST, nunca con la URL del stage, que crearía un ciclo de dependencias. `'self'` cubre el fetch de `/config.json`. Los estilos admiten `'unsafe-inline'` porque Angular inserta estilos de componentes en tiempo de ejecución y un hosting estático no puede emitir nonces por respuesta. Los scripts solo admiten `'self'`: la síntesis falla si el `index.html` del build tiene un script o un manejador de eventos inline, o si incluye un `config.json`.

El despliegue se divide en dos stacks y no requiere bootstrap de CDK:

- **Fundación** (`infra/foundation-app.ts`, `arturia-foundation`): bucket de artefactos privado, versionado, cifrado, con TLS obligatorio y política `Retain`, más los roles predefinidos del piloto. No tiene assets y su plantilla no depende de la cuenta. Requiere un administrador y la boundary externa `arturia-pilot-boundary`, cuyo documento es `boundaryPolicy()`. Los roles no pueden excederla.
- **Piloto** (`infra/pilot.ts`, `arturia-pilot`): la aplicación. `CliCredentialsStackSynthesizer` sube sus assets al bucket de la fundación con el prefijo `arturia-pilot/`. El stack importa los roles de la fundación como inmutables y no crea recursos IAM. Se despliega con el rol de CloudFormation de la fundación (`--role-arn`). `operatorPolicy()` enumera los permisos que necesita el principal que despliega.

`infra/delivery.ts` contiene los nombres fijos de los recursos y la política mínima de cada rol. No incluye IDs de cuenta: los ARN se construyen con pseudoparámetros de CloudFormation o con valores provistos al desplegar.

## Envíos a modelos y presupuesto

Los trabajos facturables usan `dispatchModel`. El chat usa `createTurnDispatcher` para leer en una sola transacción de DynamoDB la cuenta, sesión, ámbito, lease del turno, mensaje y permisos de las fuentes. Cada proveedor requiere autorización activa en el ámbito con orígenes, categorías e integraciones explícitos. Los derivados también requieren acceso vigente a la fuente. Una fuente sin resolver, un secreto detectado o material identificado como bancario bloquean el envío.

Una tabla DynamoDB contiene el presupuesto del despliegue. Cada intento reserva contra el tope de US$10 por mes calendario UTC y el tope configurable del proveedor. La unidad es el microdólar entero (1 USD = 1.000.000 µUSD). Las tarifas por millón de tokens se expresan en µUSD y se redondea hacia arriba una sola vez tras sumar los cargos por tokens. El transporte provee una cota verificada para la entrada codificada completa e impone límites para salida visible, razonamiento, argumentos de herramientas y llamadas con cargo independiente. Cada token pertenece a una sola categoría. La ausencia o el vencimiento de una tarifa impide nuevos envíos.

El registro conserva tarifa, proveedor, modelo, operación, uso y costo. La reentrega del trabajo no permite reutilizar una reserva. El reporte de uso final confirmado o la factura concilian una sola vez el mes original. Un timeout, un stream interrumpido o la falta de reporte conservan la reserva completa hasta conciliarla. Cada nuevo intento autorizado requiere otro ID. El transporte debe desactivar los reintentos implícitos.

## Scripts operativos

`src/admin/` contiene las operaciones administrativas del piloto. Los dos scripts compilan antes de ejecutarse e imprimen una línea JSON. El `sub` de Cognito aparece enmascarado en la salida. Un modo de identidad sintética o un endpoint alternativo del SDK hacen que el script se niegue a ejecutar. Los comandos que acceden a la tabla exigen `--table`, `--region`, `--profile` y `--expected-account`. Antes de leer o escribir datos, confirman la cuenta y la región con el ARN de la tabla.

| Comando | Propósito |
| --- | --- |
| `npm run provision:pilot -- --sub <sub>` | Simulación. Lista las filas que garantizaría, sin lecturas ni escrituras. |
| `... --check <destino>` | Solo lectura. Informa `absent`, `partial`, `complete` o `conflict` y si existen permisos de modelo. Sale con 2 si el estado no está completo. |
| `... --apply --confirm-totp-enrolled <destino>` | Crea en una transacción las filas que faltan: `SUBJECT`, `ACCOUNT` (activa, `mfaVerifiedAt` = ahora + 60 s, como margen ante un reloj local atrasado) y `SCOPE` de `personal` y `work`. Nunca modifica filas existentes. Una cuenta deshabilitada, acciones de ámbito distintas o un mapeo inválido detienen la ejecución antes de escribir. Nunca escribe permisos de modelo. |
| `npm run republish:outbox -- --sub <sub> <destino>` | Lista en modo de solo lectura las intenciones pendientes del outbox del usuario (`--scope` acota la búsqueda). |
| `... --apply --queue-url <url>` | Publica cada intención pendiente en la cola FIFO de turnos (`*turns.fifo`, nunca la DLQ) de la misma cuenta y región, y después la marca. Se detiene ante el primer fallo y deja pendiente el resto. Un duplicado no produce efectos, porque el worker reclama el turno persistido por su ID. |

Después de `--apply` hay que esperar más de un minuto y volver a iniciar sesión: las sesiones autenticadas antes de `mfaVerifiedAt` se rechazan. Los mensajes de la DLQ de turnos ya tienen su fila del outbox publicada y se recuperan con un redrive de SQS hacia la cola de turnos, no con `republish:outbox`. La DLQ del relay solo contiene metadatos de lotes del stream: esos turnos se recuperan con `republish:outbox`.

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
| `ARTURIA_WEB_DIR=../arturia npm run synth:pilot -- -c arturia:account=<id> -c arturia:region=<región>` | Genera los bundles y sintetiza el piloto desplegable en `cdk.pilot.out/`. Falla sin la cuenta, la región, el checkout web o su build de producción (`npm run build` en el checkout web). Agregá `-c arturia:apiRedeploy=<valor>` solo para forzar un deployment nuevo de API Gateway. |

Las pruebas de integración inician una instancia aislada de DynamoDB Local en un puerto local temporal, con credenciales sintéticas. Docker puede descargar la imagen fijada en el primer uso. La suite elimina el contenedor, los datos en memoria y la red al terminar. Cada ejecución tiene su propia tabla. Para elegir un archivo o escenario de integración, usá `npm run test:integration -- dynamodb` o `npm run test:integration -- -t local_dynamodb_conditional_write`.

Instalá las dependencias de ambos repositorios con `npm ci` y Chromium en el frontend con `npm exec -- playwright install chromium`. La suite integrada usa dos orígenes loopback y verifica el digest del contrato en `scripts/integrated-scenarios.json`.

## Licencia

Copyright © 2026 Matias Galeano ([matigaleanodev](https://github.com/matigaleanodev)), autor original. El código fuente se distribuye bajo la [Mozilla Public License 2.0](LICENSE).
