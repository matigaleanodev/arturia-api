# Security

[Español](security.es.md)

## Authentication and authorization

- Every API route requires the Cognito authorizer with the `arturia/access` scope; only the CORS preflights are anonymous.
- The [Cognito user pool](../infra/identity.ts) requires TOTP MFA and disables self-sign-up. The public browser client uses OAuth authorization code flow.
- The actor comes only from the authorizer claims for this app client, and the session is revalidated in DynamoDB. Sessions authenticated before the account's `mfaVerifiedAt` are rejected.
- Every data operation is isolated by user and scope. The SSE handler rechecks the session and the scope grant before each batch and closes on revocation.

## CORS

CORS allows one exact HTTPS origin, the web distribution's domain derived inside the pilot stack, without credentials. Preflights, Lambda responses, SSE metadata and the gateway responses (`UNAUTHORIZED`, `ACCESS_DENIED`, `THROTTLED`, `DEFAULT_4XX`, `DEFAULT_5XX`) name only that origin, and handlers without a valid origin name none.

## Web headers and CSP

A CloudFront response headers policy ([`infra/web-hosting.ts`](../infra/web-hosting.ts)) sets HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and this CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self' https://<restApiId>.execute-api.<region>.<suffix> https://<prefix>.auth.<region>.amazoncognito.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- The API origin is built from the REST API ID, never from the stage URL, which would create a dependency cycle. `'self'` covers the fetch of `/config.json`.
- Styles allow `'unsafe-inline'` because Angular inserts component styles at runtime and static hosting cannot issue per-response nonces.
- Scripts allow only `'self'`: synthesis fails if the build's `index.html` has an inline script or event handler, or ships a `config.json`.

## IAM

- The foundation requires an administrator and the external permissions boundary `arturia-pilot-boundary`, whose document is `boundaryPolicy()`. The roles cannot exceed it.
- The pilot stack creates no IAM resources and is deployed with the foundation's CloudFormation role. That role's permissions are checked against the registry handler permissions of every pilot resource type ([`infra/fixtures/cloudformation-handlers.json`](../infra/fixtures/cloudformation-handlers.json)).
- `operatorPolicy()` lists the permissions the deploying principal needs; `operatorManagedPolicy()` is the managed policy to attach to its permission set.
- [`infra/delivery.ts`](../infra/delivery.ts) holds the minimal policy of every role and no account IDs.

## Provider credentials

The worker reads the key of each enabled provider on demand, with `ssm:GetParameter`, from its own Systems Manager Parameter Store `SecureString` parameter (Standard tier, AWS managed key `alias/aws/ssm`): `/arturia/pilot/providers/<provider>/api-key`. It caches the key for at most five minutes.

- The environment holds only the reference `ARTURIA_PROVIDER_PARAMETER_PREFIX`, never a key. The stack neither creates nor resolves the parameter, so no key reaches a template, a log or an error.
- A missing, mistyped or malformed parameter fails the turn without contacting the provider. Only enabled providers are read.
- The worker role can read exactly that parameter and decrypt it through Parameter Store. `operatorManagedPolicy()` denies the deploying principal every read, write and delete under the prefix, including `GetParametersByPath` on its ancestor paths, because that call is authorized against the requested path and not against each parameter it returns.
- The administrator creates and rotates the parameter in the Systems Manager console.

## Model egress

Each provider needs an enabled scope grant with explicit origins, categories and integrations. Derived sources also require current source access. An unresolved source, a detected secret or identified banking material blocks the request. The grants are read in the same DynamoDB snapshot as the session and turn lease ([Architecture](architecture.md#model-dispatch)).

## Logging

The [structured logger](../src/observability/log.ts) records allowlisted fields, including codes, UUIDs, HTTP status and error class. Message text, prompts, claims and secrets are excluded. Credentials and message content stay out of queues as well. Logging configuration is described in [Infrastructure](infrastructure.md#logs).
