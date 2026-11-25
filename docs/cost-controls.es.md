# Control de costos

[English](cost-controls.md)

El gasto se acota en capas: un modo de proveedor seguro por defecto, un ledger mensual estricto que se consulta antes de cada envío a un modelo, throttling de solicitudes, concurrencia y capacidad acotadas, y un presupuesto de AWS que avisa pero nunca detiene el consumo.

## Modos del proveedor

`ARTURIA_PROVIDER_MODE` acepta `fixture`, `fail` y `catalog`, y únicamente con `ARTURIA_ENVIRONMENT=pilot`:

- `fixture` emite tres bloques sintéticos separados por un segundo.
- `fail` nunca ejecuta el turno, de modo que el mensaje llega a la cola de mensajes fallidos.
- `catalog` es el único modo facturable. Solo admite los proveedores y modelos habilitados en [`src/config/catalog-config.ts`](../src/config/catalog-config.ts). Actualmente, OpenAI es el único proveedor habilitado.

`-c arturia:providerMode=fixture|fail|catalog` define el modo al sintetizar sin cambiar código; cambiarlo solo modifica el entorno del worker. Sin el contexto, el worker usa `fixture`, así que un despliegue que lo omite vuelve al modo seguro. Cualquier otro valor hace fallar la síntesis. `catalog` además exige `-c arturia:model=<modelo>` y `-c arturia:tariffVerifiedAt=<AAAA-MM-DD>`.

## Ledger de gasto

Una tabla de ledger dedicada (`arturia-pilot-ledger`) contiene el presupuesto del despliegue. Pertenece a la fundación, no al stack del piloto: se retiene y tiene protección contra borrado y recuperación a un punto en el tiempo, de modo que destruir o recrear el piloto no puede reiniciar el consumo mensual. El worker la alcanza mediante `ARTURIA_LEDGER_TABLE_NAME` y el runtime rechaza un ledger con el mismo nombre que la tabla de chat.

- Cada intento reserva contra el tope de US$10 por mes calendario UTC y contra el tope configurado del proveedor.
- La unidad es el microdólar entero (1 USD = 1.000.000 µUSD). Las tarifas por millón de tokens se expresan en µUSD y se redondea hacia arriba una sola vez tras sumar los cargos por tokens.
- El transporte provee una cota verificada para la entrada codificada completa e impone límites para salida visible, razonamiento, argumentos de herramientas y llamadas con cargo independiente. Cada token pertenece a una sola categoría.
- La ausencia o el vencimiento de una tarifa impide nuevos envíos.
- El ledger registra tarifa aplicada, proveedor, modelo, operación, uso y costo.
- La reentrega no permite reutilizar una reserva. Una guarda por turno escrita en la misma transacción admite una sola reserva por turno, aunque un redrive fuera de la ventana de deduplicación de la cola inicie otro intento. Cada nuevo intento autorizado requiere otro ID, y el transporte debe desactivar los reintentos implícitos.
- El reporte de uso final confirmado o la factura concilian una sola vez el mes original. Un timeout, un stream interrumpido o la falta de reporte conservan la reserva completa.
- Una reserva incierta nunca se libera sola: un operador la liquida únicamente contra la factura o el uso exportado del proveedor ([Operación](operations.es.md#reservas-inciertas-de-modelos)).

## Límites por intento

Cada intento reserva la cota de costo de los límites exactos que envía:

- Salida: la salida máxima del modelo (4096 tokens en el piloto, nunca más de 128.000).
- Entrada: la ventana de contexto del modelo, o los bytes UTF-8 del mensaje más el encuadre del proveedor cuando existe una calibración medida con el contador de tokens del propio proveedor para ese modelo. Una calibración contradicha por una de sus muestras se rechaza.
- Un mensaje de más de 393.216 bytes se rechaza antes de reservar.
- Si el proveedor informa más tokens de entrada que la cota reservada, el intento se marca fallido y se liquida el cargo informado.
- Un tope del proveedor por debajo de la cota de un solo intento es un error de configuración: `checkCatalogConfig` lo informa al iniciar junto con cuántos intentos inciertos agotan el mes, y la reserva rechaza el envío en caso contrario.

## Throttling y capacidad

- El throttling del stage apunta a 10 solicitudes por segundo con ráfaga de 20 por método. Los turnos aceptados se limitan a 1/5 y SSE a 1/4, lo que mantiene las funciones de streaming concurrentes en 33 como máximo. Los valores están en [`infra/chat-api.ts`](../infra/chat-api.ts).
- API Gateway aplica estos límites por método y como mejor esfuerzo, y responde `429 RATE_LIMITED` con la forma pública de error.
- La concurrencia reservada de SSE está desactivada salvo que se configure, y en ese caso debe cubrir todos los streams que admite el throttling.
- La fuente de eventos del worker tiene concurrencia máxima 2.
- La tabla on-demand limita las unidades de lectura y escritura por segundo (`TABLE_LIMITS` en [`infra/cost-controls.ts`](../infra/cost-controls.ts), con el cálculo del pico esperado).
- Una alarma se dispara con 2.000 o más solicitudes a la API por hora ([Operación](operations.es.md#alarmas)).

## Presupuesto de AWS

El budget `arturia-aws-monthly` de la fundación ([`infra/cost-controls.ts`](../infra/cost-controls.ts)) es de US$10 por mes, filtra por la etiqueta de asignación de costos `Project=arturia` y avisa por correo a `BudgetAlertEmail` a US$5 y US$8 de gasto real y a US$10 de gasto pronosticado. Excluye créditos y reembolsos.

- No tiene acciones: avisa con el retraso de la facturación y nunca detiene el consumo. Para detener los envíos a modelos, usá el [interruptor del worker](operations.es.md#interruptor-del-worker).
- La etiqueta debe estar activada como cost allocation tag para que el budget la vea, y los cargos que no admiten etiquetas quedan fuera del filtro.
