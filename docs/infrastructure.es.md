# Infraestructura

[English](infrastructure.md)

La infraestructura es código AWS CDK v2 en [`infra/`](../infra/). El App ([`infra/bin/app.ts`](../infra/bin/app.ts)) etiqueta los recursos con `Project` y `Environment`.

## Stacks

El despliegue se divide en dos stacks y no requiere bootstrap de CDK.

- **Fundación** ([`infra/foundation-app.ts`](../infra/foundation-app.ts), `arturia-foundation`): bucket de artefactos privado, versionado, cifrado, con TLS obligatorio y política `Retain`; los roles predefinidos del piloto; la política administrada `arturia-pilot-cloudformation-hosting` asociada al rol de CloudFormation (permisos de hosting web y observabilidad; `cloudformationPolicies()` divide el rol entre esta política y su política inline para respetar los límites de tamaño de IAM); la política administrada `arturia-pilot-operator` (`operatorManagedPolicy()`, para asociar a un permission set); la tabla del ledger de gasto; y el presupuesto mensual. No tiene assets y su plantilla no depende de la cuenta. El parámetro `BudgetAlertEmail` recibe el correo de las alertas al desplegar.
- **Piloto** ([`infra/pilot.ts`](../infra/pilot.ts), `arturia-pilot`): la aplicación. `CliCredentialsStackSynthesizer` sube sus assets al bucket de la fundación con el prefijo `arturia-pilot/`. El stack importa los roles de la fundación como inmutables y no crea recursos IAM. Se despliega con el rol de CloudFormation de la fundación. El parámetro `AlertEmail` recibe las notificaciones de las alarmas.

Separar IAM y los datos retenidos en la fundación permite destruir y recrear el piloto sin permisos elevados y sin reiniciar el gasto mensual. Los detalles de IAM están en [Seguridad](security.es.md#iam).

[`infra/delivery.ts`](../infra/delivery.ts) contiene los nombres fijos de los recursos y la política mínima de cada rol. No incluye IDs de cuenta: los ARN se construyen con pseudoparámetros de CloudFormation o con valores provistos al desplegar.

## Hosting web

El cliente web se aloja en un bucket S3 privado (`arturia-pilot-web-<cuenta>-<región>`, acceso público bloqueado, solo TLS) que CloudFront lee mediante origin access control ([`infra/web-hosting.ts`](../infra/web-hosting.ts)). No hay dominio propio: el origen es el dominio `cloudfront.net` de la distribución, y de él se derivan el origen de CORS y las URL de callback y logout de Cognito. Una CloudFront Function sirve `index.html` en las rutas sin extensión. Los archivos, incluido `/config.json`, nunca se reescriben, y un archivo faltante queda como un 403 de S3.

Tres deployments publican el build de Angular y su configuración con el rol predefinido `publisher`:

| Deployment | Archivos | `Cache-Control` | Prune |
|---|---|---|---|
| Assets | `*.js`, `*.css`, `media/*` (con hash de contenido, verificado al sintetizar) | `public, max-age=31536000, immutable` | No: las pestañas abiertas y los rollbacks siguen encontrando los chunks anteriores |
| Páginas | El resto del build, incluido `index.html` | `no-cache` | Dentro de su filtro, nunca `config.json` |
| Configuración | `config.json`, generado desde el stack (URL base de la API con el stage, dominio y cliente de Cognito, URL de retorno) | `no-store`, `application/json` | No |

El deployment de páginas corre después del de assets, para que un `index.html` nuevo nunca referencie bundles ausentes, y la configuración va al final. La política de caché por defecto tiene TTL mínimo 0, así que CloudFront respeta el `Cache-Control` de cada objeto. `/config.json` tiene un comportamiento propio con la caché desactivada, solo HTTPS, sin función y con `Cache-Control: no-store` forzado en la respuesta. Las respuestas 403 y 404 no se cachean. No hay invalidaciones. Los headers de seguridad de las respuestas se describen en [Seguridad](security.es.md#headers-web-y-csp).

## Logs

Cada función, incluido el handler de `BucketDeployment`, escribe en un log group explícito `/aws/lambda/<función>` con 14 días de retención, formato JSON, nivel de aplicación `INFO` y nivel de plataforma `WARN`. Los roles de runtime no pueden crear log groups.

Los access logs del stage están desactivados por defecto. `-c arturia:apiAccessLogs=true` los habilita en `arturia-pilot-api-access` con un formato que no incluye path, cuerpo, headers, identidad ni claims. Requieren que la cuenta ya tenga el rol de CloudWatch de API Gateway, que este stack no crea. Nunca se habilitan los logs de ejecución ni el data trace.

## Retención y eliminación

- Se eliminan con el stack del piloto: la tabla de chat (sin recuperación a un punto en el tiempo ni deletion protection), el user pool, el bucket web, las colas y los log groups.
- La cola de turnos y ambas colas de mensajes fallidos retienen 14 días.
- Se conservan: el bucket de artefactos y todos los recursos de la fundación, incluida la tabla del ledger.
- El bucket web tiene un nombre fijo y no tiene un custom resource de borrado automático: hay que vaciarlo antes de eliminar el stack, porque CloudFormation no borra un bucket con objetos.
