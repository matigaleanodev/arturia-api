# Seguridad

[English](security.md)

## Autenticación y autorización

- Todas las rutas de la API exigen el authorizer de Cognito con el scope `arturia/access`; solo los preflight de CORS son anónimos.
- El [user pool de Cognito](../infra/identity.ts) exige MFA con TOTP y deshabilita el registro autónomo. El cliente público del navegador usa el flujo de código de autorización de OAuth.
- El actor sale solo de los claims del authorizer para este cliente de la app, y la sesión se revalida en DynamoDB. Las sesiones autenticadas antes del `mfaVerifiedAt` de la cuenta se rechazan.
- Toda operación de datos se aísla por usuario y ámbito. El handler SSE comprueba la sesión y el permiso de ámbito antes de cada lote y cierra ante una revocación.

## CORS

CORS admite un único origen HTTPS exacto, el dominio de la distribución web derivado dentro del stack piloto, sin credenciales. Los preflight, las respuestas de Lambda, los metadatos SSE y las gateway responses (`UNAUTHORIZED`, `ACCESS_DENIED`, `THROTTLED`, `DEFAULT_4XX`, `DEFAULT_5XX`) nombran solo ese origen, y un handler sin origen válido no nombra ninguno.

## Headers web y CSP

Una response headers policy de CloudFront ([`infra/web-hosting.ts`](../infra/web-hosting.ts)) define HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y esta CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self' https://<restApiId>.execute-api.<región>.<sufijo> https://<prefijo>.auth.<región>.amazoncognito.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- El origen de la API se arma con el ID de la API REST, nunca con la URL del stage, que crearía un ciclo de dependencias. `'self'` cubre el fetch de `/config.json`.
- Los estilos admiten `'unsafe-inline'` porque Angular inserta estilos de componentes en tiempo de ejecución y un hosting estático no puede emitir nonces por respuesta.
- Los scripts solo admiten `'self'`: la síntesis falla si el `index.html` del build tiene un script o un manejador de eventos inline, o si incluye un `config.json`.

## IAM

- La fundación requiere un administrador y la boundary externa `arturia-pilot-boundary`, cuyo documento es `boundaryPolicy()`. Los roles no pueden excederla.
- El stack del piloto no crea recursos IAM y se despliega con el rol de CloudFormation de la fundación. Los permisos de ese rol se comparan con los permisos de los handlers del registro de cada tipo de recurso del piloto ([`infra/fixtures/cloudformation-handlers.json`](../infra/fixtures/cloudformation-handlers.json)).
- `operatorPolicy()` enumera los permisos que necesita el principal que despliega; `operatorManagedPolicy()` es la política administrada para asociar a su permission set.
- [`infra/delivery.ts`](../infra/delivery.ts) contiene la política mínima de cada rol y ningún ID de cuenta.

## Credenciales de proveedores

El worker lee bajo demanda la clave de cada proveedor habilitado, con `ssm:GetParameter`, desde su propio parámetro `SecureString` de Systems Manager Parameter Store (nivel Standard, clave administrada `alias/aws/ssm`): `/arturia/pilot/providers/<proveedor>/api-key`. La conserva en caché como máximo cinco minutos.

- El entorno solo lleva la referencia `ARTURIA_PROVIDER_PARAMETER_PREFIX`, nunca una clave. El stack ni crea ni resuelve el parámetro, así que ninguna clave llega a una plantilla, un log o un error.
- Un parámetro inexistente, mal escrito o con formato inválido hace fallar el turno sin contactar al proveedor. Solo se leen los proveedores habilitados.
- El rol del worker puede leer exactamente ese parámetro y descifrarlo a través de Parameter Store. `operatorManagedPolicy()` le niega al principal que despliega toda lectura, escritura y borrado bajo el prefijo, incluido `GetParametersByPath` en sus rutas ancestro, porque esa llamada se autoriza contra la ruta pedida y no contra cada parámetro que devuelve.
- El administrador crea y rota el parámetro desde la consola de Systems Manager.

## Envíos a modelos

Cada proveedor requiere un permiso activo en el ámbito con orígenes, categorías e integraciones explícitos. Las fuentes derivadas también requieren acceso vigente a la fuente. Una fuente sin resolver, un secreto detectado o material identificado como bancario bloquean el envío. Los permisos se leen en la misma instantánea de DynamoDB que la sesión y el lease del turno ([Arquitectura](architecture.es.md#envío-a-modelos)).

## Logs

El [logger estructurado](../src/observability/log.ts) registra campos permitidos, entre ellos códigos, UUID, estado HTTP y clase de error. Excluye texto de mensajes, prompts, claims y secretos. Las credenciales y el contenido de los mensajes también quedan fuera de las colas. La configuración de logs se describe en [Infraestructura](infrastructure.es.md#logs).
