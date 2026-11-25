# Infrastructure

[Español](infrastructure.es.md)

The infrastructure is AWS CDK v2 code in [`infra/`](../infra/). The App ([`infra/bin/app.ts`](../infra/bin/app.ts)) tags resources with `Project` and `Environment`.

## Stacks

Deployment is split into two stacks and needs no CDK bootstrap.

- **Foundation** ([`infra/foundation-app.ts`](../infra/foundation-app.ts), `arturia-foundation`): a private, versioned, encrypted artifact bucket with TLS enforced and a `Retain` policy; the pilot's predefined roles; the `arturia-pilot-cloudformation-hosting` managed policy attached to the CloudFormation role (web hosting and observability permissions; `cloudformationPolicies()` splits the role into this policy and its inline policy to stay within IAM size limits); the `arturia-pilot-operator` managed policy (`operatorManagedPolicy()`, to attach to a permission set); the spending ledger table; and the monthly budget. It has no assets and its template is account-agnostic. The `BudgetAlertEmail` parameter takes the alert email at deployment.
- **Pilot** ([`infra/pilot.ts`](../infra/pilot.ts), `arturia-pilot`): the application. `CliCredentialsStackSynthesizer` uploads its assets to the foundation bucket under the `arturia-pilot/` prefix. The stack imports the foundation roles as immutable and creates no IAM resources. It is deployed with the foundation's CloudFormation role. The `AlertEmail` parameter receives the alarm notifications.

Separating IAM and retained data into the foundation lets the pilot be destroyed and recreated without elevated permissions and without resetting the monthly spending. IAM details are in [Security](security.md#iam).

[`infra/delivery.ts`](../infra/delivery.ts) holds fixed resource names and the minimal policy of every role. It contains no account IDs: ARNs are built from CloudFormation pseudo parameters or from values supplied when deploying.

## Web hosting

The web client is hosted on a private S3 bucket (`arturia-pilot-web-<account>-<region>`, public access blocked, TLS only) read by CloudFront through origin access control ([`infra/web-hosting.ts`](../infra/web-hosting.ts)). There is no custom domain: the origin is the distribution's `cloudfront.net` domain, and the CORS origin and the Cognito callback and logout URLs derive from it. A CloudFront Function serves `index.html` for paths without an extension. Files, including `/config.json`, are never rewritten, and a missing file stays a 403 from S3.

Three deployments publish the Angular build and its configuration with the predefined `publisher` role:

| Deployment | Files | `Cache-Control` | Prune |
|---|---|---|---|
| Assets | `*.js`, `*.css`, `media/*` (content-hashed, checked at synthesis) | `public, max-age=31536000, immutable` | No: open tabs and rollbacks keep finding earlier chunks |
| Pages | Every other file of the build, `index.html` included | `no-cache` | Within its filter, never `config.json` |
| Configuration | `config.json`, generated from the stack (API base URL with the stage, Cognito domain and client, return URLs) | `no-store`, `application/json` | No |

The pages deployment runs after the assets, so a new `index.html` never references missing bundles, and the configuration goes last. The default cache policy has a minimum TTL of 0, so CloudFront follows each object's `Cache-Control`. `/config.json` has its own behavior with caching disabled, HTTPS only, no function and `Cache-Control: no-store` forced on the response. 403 and 404 responses are not cached. There are no invalidations. Response security headers are described in [Security](security.md#web-headers-and-csp).

## Logs

Every function, the `BucketDeployment` handler included, writes to an explicit `/aws/lambda/<function>` log group with 14-day retention, JSON format, application level `INFO` and platform level `WARN`. The runtime roles cannot create log groups.

Stage access logs are off by default. `-c arturia:apiAccessLogs=true` enables them in `arturia-pilot-api-access` with a format that has no path, body, headers, identity or claims. They need the account's API Gateway CloudWatch role, which this stack never creates. Execution logging and data trace are never enabled.

## Retention and deletion

- Deleted with the pilot stack: the chat table (no point-in-time recovery or deletion protection), the user pool, the web bucket, the queues and the log groups.
- The turn queue and both dead-letter queues keep messages for 14 days.
- Retained: the artifact bucket and every foundation resource, including the ledger table.
- The web bucket has a fixed name and no auto-delete custom resource: empty it before deleting the stack, because CloudFormation does not delete a bucket that still has objects.
