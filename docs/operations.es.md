# Operación

[English](operations.md)

## Alarmas

El tema `arturia-pilot-alerts` envía las alarmas al correo del parámetro `AlertEmail`, que hay que confirmar desde el mensaje de suscripción. El tema no usa el cifrado administrado por AWS, que impediría publicar a CloudWatch.

Cada alarma se dispara con un solo punto de datos. Los umbrales están en [`infra/observability.ts`](../infra/observability.ts):

- Mensajes visibles en cada cola de mensajes fallidos, y antigüedad de la cola de mensajes fallidos de turnos (7 días).
- `IteratorAge` del relay (5 min) y antigüedad de la cola de turnos (10 min).
- `Errors` de las funciones HTTP, SSE, worker y relay; `Throttles` de HTTP y SSE.
- `5XXError` del stage, y 2.000 o más solicitudes por hora.

Un fallo del worker devuelto como `batchItemFailures` no incrementa `Errors`: lo detectan la antigüedad de la cola y la cola de mensajes fallidos. SQS deja de publicar métricas de una cola sin actividad durante seis horas, por eso las alarmas de las colas de mensajes fallidos conservan su estado cuando faltan datos.

## Interruptor del worker

`-c arturia:workerPaused=true` y un nuevo despliegue deshabilitan el event source mapping del worker. Los mensajes nuevos esperan en la cola hasta 14 días. Las invocaciones que ya están en curso pueden terminar. `false` lo reanuda. La síntesis desplegable exige el contexto (`true` o `false`), así que un despliegue no puede reanudar un worker pausado por omisión.

Para volver al modo no facturable sin pausar, configurá `-c arturia:providerMode=fixture` u omití esa opción. Quitá `arturia:model` y `arturia:tariffVerifiedAt` del contexto, volvé a sintetizar y desplegá. Consultá [Control de costos](cost-controls.es.md#modos-del-proveedor).

## Scripts operativos

[`src/admin/`](../src/admin/) contiene las operaciones administrativas. Los scripts compilan antes de ejecutarse e imprimen una línea JSON. El `sub` de Cognito aparece enmascarado en la salida. Un modo de identidad sintética o un endpoint alternativo del SDK hacen que el script se niegue a ejecutar. Los comandos que acceden a DynamoDB requieren `--region`, `--profile` y `--expected-account` (abreviados abajo como `<destino>`). Los que acceden a la tabla de chat también requieren `--table` con su nombre. Los scripts verifican el ARN de cada tabla antes de acceder a sus datos.

| Comando | Propósito |
| --- | --- |
| `npm run provision:pilot -- --sub <sub>` | Simulación. Lista las filas que garantizaría, sin lecturas ni escrituras. |
| `... --check --table <chat> <destino>` | Solo lectura. Informa `absent`, `partial`, `complete` o `conflict` y si existen permisos de modelo. Sale con 2 si el estado no está completo. |
| `... --apply --confirm-totp-enrolled --table <chat> <destino>` | Crea en una transacción las filas que faltan: `SUBJECT`, `ACCOUNT` (activa, `mfaVerifiedAt` = ahora + 60 s, como margen ante un reloj local atrasado) y `SCOPE` de `personal` y `work`. Nunca modifica filas existentes. Una cuenta deshabilitada, acciones de ámbito distintas o un mapeo inválido detienen la ejecución antes de escribir. No escribe permisos de modelo salvo que se agregue `--model-grants`. |
| `... --apply --before-first-login --table <chat> <destino>` | Igual que el anterior para una persona que todavía no inició sesión (no hay token antes de enrolar TOTP): `mfaVerifiedAt` = ahora - 60 s, para que el inicio de sesión que enrola TOTP se acepte de inmediato. Excluyente con `--confirm-totp-enrolled`. |
| `... --apply ... --model-grants` | Tras un aprovisionamiento completo, escribe además el permiso de modelo de OpenAI del ámbito `personal` si no existe. Una fila idéntica no cambia nada; una distinta es un conflicto que se resuelve a mano. |
| `npm run republish:outbox -- --sub <sub> --table <chat> <destino>` | Lista en modo de solo lectura las intenciones pendientes del outbox del usuario (`--scope` acota la búsqueda). |
| `... --apply --queue-url <url>` | Publica cada intención pendiente en la cola FIFO de turnos (`*turns.fifo`, nunca la cola de mensajes fallidos) de la misma cuenta y región, y después la marca. Se detiene ante el primer fallo y deja pendiente el resto. Un duplicado no produce efectos, porque el worker reclama el turno persistido por su ID. |
| `npm run settle:attempts -- --all-users --month AAAA-MM --ledger-table <ledger> <destino>` | Solo lectura. Lista las reservas inciertas de un mes UTC. Para consultar un usuario, reemplazá `--all-users` por `--sub <sub> --table <chat>`. `--scope` acota los resultados. |
| `... --evidence <archivo>` | Simulación. Cruza la factura o el uso exportado (`{month, entries: [{attemptId, costMicros, reference}]}`) con las reservas. Los intentos sin evidencia conservan su reserva. Sale con 2 si una entrada no se pudo cruzar. |
| `... --evidence <archivo> --apply` | Liquida solo los intentos cruzados, una vez y con fila de auditoría. Repetirlo no cambia nada. |
| `npm run pilot:inspect -- --sub <sub> --table <chat> <destino> --turn <id> --scope <id>` | Solo lectura. Estado, intentos iniciados (`claims`), estado del envío y del outbox de un turno, sin su contenido. |
| `npm run pilot:inspect -- --sub <sub> --table <chat> <destino> --stale [--older-than-minutes <n>]` | Solo lectura. Turnos `queued` o `running` del usuario aceptados hace más de `n` minutos (60 por defecto, de 15 a 20160), con el estado de su outbox. Sale con 2 si hay alguno. |
| `npm run smoke:sse:aws` | Prueba de humo SSE para un piloto desplegado en modo `fixture`. Definí `ARTURIA_SMOKE_API_URL` con la URL HTTPS del stage y `ARTURIA_SMOKE_ACCESS_TOKEN` con el access token de un usuario de prueba. Crea una conversación y un turno sintéticos, corta la conexión después del primer bloque y la reanuda con el cursor. No escribe archivos ni muestra el token o la URL. Las opciones se definen en [`src/smoke/sse-smoke.ts`](../src/smoke/sse-smoke.ts). |

## Procedimientos de recuperación

### Usuario nuevo

El registro autónomo está deshabilitado. Creá el usuario en Cognito y usá su `sub` para aprovisionarlo. Ejecutá `provision:pilot` con `--apply --before-first-login` antes del primer inicio de sesión de la persona, o con `--apply --confirm-totp-enrolled` cuando ya enroló TOTP, y confirmá con `--check`. Después de `--confirm-totp-enrolled`, esperá más de un minuto y volvé a iniciar sesión: las sesiones autenticadas antes de `mfaVerifiedAt` se rechazan. Los permisos de modelo son un paso aparte y explícito (`--model-grants`).

### Turnos trabados

Encontralos con `pilot:inspect --stale` e inspeccioná cada uno con `--turn`. Un turno cuya intención del outbox sigue pendiente se vuelve a publicar con `republish:outbox --apply`.

### Colas de mensajes fallidos

- **Cola de mensajes fallidos de turnos:** sus mensajes ya tienen su fila del outbox publicada. Se recuperan con un redrive de SQS hacia la cola de turnos, no con `republish:outbox`.
- **Cola de mensajes fallidos del relay:** solo contiene metadatos de lotes del stream. Sus turnos se recuperan con `republish:outbox`.

### Reservas inciertas de modelos

Un timeout, un stream interrumpido o la falta de reporte de uso dejan la reserva en pie. Listá los intentos inciertos del mes con `settle:attempts`, exportá la factura o el uso del proveedor, ejecutá la simulación con `--evidence` y aplicala cuando todas las entradas crucen. Usá `--all-users` si se recreó la tabla de chat. El listado omite las reservas con menos antigüedad que `MIN_UNCERTAIN_AGE_SECONDS`, definido en [el código de conciliación](../src/models/settlement-admin.ts). La evidencia para esas reservas se rechaza con `too-recent`.

### Deployment de API Gateway desactualizado

Ver [Despliegue](deployment.es.md#forzar-un-deployment-nuevo-de-la-api).
