# Arquitectura

[English](architecture.md)

Arturia API atiende conversaciones organizadas por usuario y ámbito. Un turno se acepta por HTTP, se persiste junto con una intención del outbox, se reenvía a una cola SQS FIFO y lo genera un worker que escribe bloques de texto; el cliente los lee por SSE.

## Interfaz

- [`contracts/openapi.json`](../contracts/openapi.json) y [`contracts/sse.schema.json`](../contracts/sse.schema.json) definen la interfaz HTTP y SSE, incluida la forma pública de error. Los fixtures están en [`contracts/fixtures/`](../contracts/fixtures/).
- [`src/http/routes.ts`](../src/http/routes.ts) enumera cada ruta una sola vez; lo comparten el adaptador Lambda y la composición de API Gateway.
- Los títulos de conversación y los textos de mensajes admiten hasta 393.216 bytes UTF-8 cada uno. Los identificadores de ámbito, conversación y turno en las rutas admiten hasta 256 bytes UTF-8 cada uno. Los valores que exceden estos límites reciben HTTP 400 con código `INVALID_REQUEST`.
- El endpoint de eventos del turno admite el cursor opcional `after`, un entero mayor o igual que cero. Lee bloques persistidos, comprueba la sesión y el permiso de ámbito antes de cada lote y cierra tras el estado terminal, la revocación o el límite de tiempo de la conexión. Los clientes se reconectan con la última secuencia de texto recibida. Los comentarios de latido carecen de datos.

## Handlers Lambda

`npm run bundle` genera un bundle autocontenido para Node.js 24 por handler en `dist/bundles/<nombre>/index.cjs`. `BUNDLES` en [`infra/delivery.ts`](../infra/delivery.ts) enumera los puntos de entrada, que deben estar en `src/`.

| Bundle | Handler | Configuración |
|---|---|---|
| `http` | Proxy REST de conversaciones y turnos (`src/http/turns.lambda.ts`). | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID`, `ARTURIA_ALLOWED_ORIGIN` |
| `worker` | Consumidor SQS de turnos (`src/chat/generate.lambda.ts`). `retry`, los mensajes inválidos y los fallos se devuelven como `batchItemFailures`; en un lote FIFO, los mensajes restantes se devuelven sin procesar. | `ARTURIA_TABLE_NAME`, `ARTURIA_ENVIRONMENT`, `ARTURIA_PROVIDER_MODE` |
| `stream` | Eventos SSE del turno en modo streaming (`src/chat/stream.lambda.ts`). | `ARTURIA_TABLE_NAME`, `ARTURIA_CLIENT_ID`, `ARTURIA_ALLOWED_ORIGIN` |
| `relay` | Relay del outbox desde el stream de DynamoDB hacia SQS (`src/jobs/outbox.worker.ts`). | `ARTURIA_TABLE_NAME`, `ARTURIA_TURN_QUEUE_URL` |

Los handlers `http` y `worker` leen y validan su configuración una vez por entorno de ejecución. Una configuración inválida falla cerrada: HTTP responde `500 INTERNAL_ERROR` con la forma pública de error y el worker hace fallar la invocación para que todos los mensajes vuelvan a la cola.

## API

`addChatApi`, en [`infra/chat-api.ts`](../infra/chat-api.ts), crea la API REST Regional y su autorizador de Cognito. Llama a `addChatStream`, en [`infra/chat-stream.ts`](../infra/chat-stream.ts), para registrar la ruta GET de eventos y la Lambda de entrega. La entrega requiere una sesión de Arturia existente.

La ruta SSE invoca la función `stream` con response streaming y un timeout de integración de 29 s, menor que el límite de 15 minutos del streaming en APIs REST. En lugar de conexiones largas, los clientes se reconectan con el cursor `after`, de modo que una conexión cerrada nunca pierde bloques.

## Procesamiento de turnos

Las duraciones están en [`src/config/timing.ts`](../src/config/timing.ts), compartido por el código y la composición CDK, y se validan al sintetizar:

- El timeout del proveedor (45 s) más un margen de cierre es menor que el timeout del worker (60 s), que el lease del turno (75 s) cubre.
- La visibilidad de `TurnQueue` (360 s, seis veces el timeout de la función) supera la suma del timeout del worker y el lease, de modo que una reentrega siempre encuentra el lease vencido.
- Tres operaciones de persistencia en el peor caso entran en el margen de cierre, y el timeout del transporte es menor que el plazo del proveedor.

La fuente de eventos entrega un mensaje por invocación con respuestas parciales de lote y concurrencia máxima 2, en lugar de concurrencia reservada. Los mensajes se retienen 14 días y pasan a la cola FIFO de mensajes fallidos tras 5 recepciones.

El grupo de mensajes es un hash de usuario y ámbito: un turno reintentado retiene los turnos siguientes del mismo usuario y ámbito durante toda la visibilidad, nunca los de otro ámbito o usuario. Un turno reentregado cuyo envío cruzó el límite del proveedor termina como `SEND_UNCERTAIN` y nunca se reenvía ni vuelve a reservar presupuesto.

El worker limita el plazo del proveedor al tiempo restante de la invocación menos el margen de cierre, y reintenta antes de reclamar un turno cuando esa ventana es demasiado corta. El cliente DynamoDB de cada función tiene timeouts de conexión y de solicitud acotados (el de solicitud solo se aplica con `throwOnRequestTimeout`) y dos intentos por operación; las transacciones reutilizan su token entre intentos. Si DynamoDB sigue degradado más allá del margen, Lambda termina la invocación y el turno queda incierto hasta que venza su lease, sin producir una segunda llamada al proveedor.

## Envío a modelos

Los trabajos facturables usan `dispatchModel`. El chat usa `createTurnDispatcher` para leer en una sola instantánea de DynamoDB la cuenta, sesión, ámbito, lease del turno, mensaje y permisos de las fuentes antes de cualquier envío. Las reglas de salida están en [Seguridad](security.es.md#envíos-a-modelos) y las de gasto en [Control de costos](cost-controls.es.md).
