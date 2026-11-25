# Despliegue

[English](deployment.md)

Desplegar crea recursos facturables en AWS. Usá la versión de Node.js de [`.nvmrc`](../.nvmrc), instalá las dependencias con `npm ci` en ambos checkouts y seleccioná las credenciales de AWS de la cuenta y región de destino. Consultá [Seguridad](security.es.md), [Control de costos](cost-controls.es.md) y [Composición de los stacks](infrastructure.es.md#stacks).

## Síntesis

| Comando | Resultado |
|---|---|
| `npm run synth` | Síntesis de prueba en `cdk.out/`: cuenta sintética, bundles de reemplazo, stack `arturia-pilot-synthetic` y salida `SyntheticSynth=true`. No es desplegable. |
| `npm run synth:foundation` | Fundación en `cdk.foundation.out/`. No depende de la cuenta ni tiene assets. |
| `npm run synth:pilot` con el contexto de abajo | Genera los bundles y sintetiza el piloto desplegable en `cdk.pilot.out/`. Falla sin la cuenta, la región, el interruptor, el checkout web o su build de producción (`npm run build` en el checkout web). |

Las claves de contexto del piloto se validan en [`infra/pilot.ts`](../infra/pilot.ts).

| Clave | Valores |
|---|---|
| `arturia:account`, `arturia:region` | Obligatorias. Cuenta y región de destino. |
| `arturia:workerPaused` | Obligatoria, `true` o `false`. Ver el [interruptor del worker](operations.es.md#interruptor-del-worker). |
| `arturia:providerMode` | `fixture` (por defecto si se omite), `fail` o `catalog`. Ver [Control de costos](cost-controls.es.md#modos-del-proveedor). |
| `arturia:model`, `arturia:tariffVerifiedAt` | Obligatorias con `catalog` y rechazadas en otro caso. Elegí un [modelo habilitado](../src/config/catalog-config.ts). Usá una fecha de verificación de tarifa en `AAAA-MM-DD`, interpretada a medianoche UTC. La síntesis rechaza fechas futuras o de más de 90 días de antigüedad. |
| `arturia:apiAccessLogs` | `true` habilita los access logs del stage ([Infraestructura](infrastructure.es.md#logs)). |
| `arturia:apiRedeploy` | De 1 a 64 letras, dígitos, puntos, guiones o guiones bajos. Solo para forzar un deployment nuevo de API Gateway. |

## Primer despliegue

1. Un administrador crea la boundary externa `arturia-pilot-boundary` a partir de [`boundaryPolicy()`](../infra/delivery.ts) y después sintetiza y despliega la fundación. Definí `BUDGET_ALERT_EMAIL` con el correo que recibe las alertas del presupuesto.

   ```bash
   npm run synth:foundation
   npx cdk deploy --app cdk.foundation.out --parameters "BudgetAlertEmail=$BUDGET_ALERT_EMAIL"
   ```

2. Activá `Project` como cost allocation tag y asociá la política administrada `arturia-pilot-operator` al permission set del principal que despliega. Para `catalog`, el administrador también crea la [credencial del proveedor](security.es.md#credenciales-de-proveedores).
3. Ejecutá `npm run build` en el checkout web. Desde el checkout de la API, definí `ACCOUNT` y `REGION` con el destino, `PARTITION` con su partición ARN (`aws` para las regiones estándar), `ALERT_EMAIL` con el correo de las alarmas del piloto y `COGNITO_DOMAIN_PREFIX` con un prefijo de dominio disponible en Cognito. Usá las credenciales del operador para sintetizar y desplegar el piloto.

   ```bash
   ARTURIA_WEB_DIR=../arturia npm run synth:pilot -- \
     -c "arturia:account=$ACCOUNT" -c "arturia:region=$REGION" -c arturia:workerPaused=false
   npx cdk deploy --app cdk.pilot.out \
     --role-arn "arn:$PARTITION:iam::$ACCOUNT:role/arturia-pilot-cloudformation" \
     --parameters "AlertEmail=$ALERT_EMAIL" \
     --parameters "CognitoDomainPrefix=$COGNITO_DOMAIN_PREFIX"
   ```

4. Confirmá el correo de suscripción a las alarmas. Creá un usuario en el user pool de Cognito y [aprovisioná su cuenta en Arturia](operations.es.md#usuario-nuevo). En modo `fixture`, ejecutá la [prueba de humo SSE](operations.es.md#scripts-operativos) contra la URL del stage.

Omitir `arturia:providerMode` despliega el modo no facturable `fixture`; `catalog` es una elección explícita.

## Actualizaciones y rollback

Todo cambio, incluidos el modo del proveedor y el interruptor del worker, es una síntesis nueva más un despliegue; no hay interruptores en tiempo de ejecución. Para hacer rollback, sintetizá la revisión anterior con el mismo contexto y volvé a desplegarla. Los assets web nunca se eliminan, así que las pestañas abiertas y un `index.html` restaurado siguen encontrando sus chunks; `config.json` se regenera desde el stack.

Para detener nuevas llamadas a modelos, usá el [interruptor del worker](operations.es.md#interruptor-del-worker).

## Forzar un deployment nuevo de la API

API Gateway sirve una instantánea de su configuración: los cambios de preflight, gateway responses y métodos llegan al stage solo con un deployment nuevo. CDK deriva el ID lógico del deployment de la configuración tal como está escrita en la plantilla, no de los valores que resuelve CloudFormation.

- Por eso el origen de CORS sale de la distribución (`Fn::GetAtt`) y nunca de un parámetro del stack, un import o una referencia dinámica, cosa que una prueba verifica. Reemplazar la distribución implica un ID lógico nuevo y, con él, un deployment nuevo. CloudFront nunca reemplaza una distribución al actualizarla, así que su dominio no puede cambiar con el mismo ID lógico.
- El piloto activa `@aws-cdk/aws-apigateway:authorizerChangeDeploymentLogicalId`, para que los cambios del authorizer generen un deployment nuevo.
- Un valor que cambia fuera de la plantilla deja el stage en el deployment anterior: un reemplazo manual, un recurso importado o un user pool reemplazado con el mismo ID lógico, que el authorizer referencia por ARN.

Para recuperarlo, sintetizá con `-c arturia:apiRedeploy=<valor>`, con cualquier valor distinto del anterior, y volvé a desplegar: el stage pasa a un deployment nuevo y no cambia nada más. Es preferible a `aws apigateway create-deployment`, que deja el stage fuera de CloudFormation.

## Eliminación del piloto

Vaciá el bucket web antes de eliminar el stack del piloto. Revisá primero [qué recursos se eliminan y cuáles se conservan](infrastructure.es.md#retención-y-eliminación).
