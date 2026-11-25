# Deployment

[Español](deployment.es.md)

Deploying creates billable AWS resources. Use the Node.js version in [`.nvmrc`](../.nvmrc), install dependencies with `npm ci` in both checkouts, and select AWS credentials for the intended account and region. See [Security](security.md), [Cost controls](cost-controls.md) and [Stack composition](infrastructure.md#stacks).

## Synthesis

| Command | Output |
|---|---|
| `npm run synth` | Test synthesis into `cdk.out/`: synthetic account, placeholder bundles, stack `arturia-pilot-synthetic` and output `SyntheticSynth=true`. Not deployable. |
| `npm run synth:foundation` | Foundation into `cdk.foundation.out/`. Account-agnostic, no assets. |
| `npm run synth:pilot` with the context below | Builds the bundles and synthesizes the deployable pilot into `cdk.pilot.out/`. Fails without the account, the region, the switch, the web checkout or its production build (`npm run build` in the web checkout). |

Pilot context keys are validated in [`infra/pilot.ts`](../infra/pilot.ts).

| Key | Values |
|---|---|
| `arturia:account`, `arturia:region` | Required. Target account and region. |
| `arturia:workerPaused` | Required, `true` or `false`. See the [worker kill switch](operations.md#worker-kill-switch). |
| `arturia:providerMode` | `fixture` (default when omitted), `fail` or `catalog`. See [Cost controls](cost-controls.md#provider-modes). |
| `arturia:model`, `arturia:tariffVerifiedAt` | Required with `catalog` and rejected otherwise. Choose an [enabled model](../src/config/catalog-config.ts). Use a tariff verification date in `YYYY-MM-DD`, interpreted at midnight UTC. Synthesis rejects future dates and dates more than 90 days old. |
| `arturia:apiAccessLogs` | `true` enables stage access logs ([Infrastructure](infrastructure.md#logs)). |
| `arturia:apiRedeploy` | 1-64 letters, digits, dots, dashes or underscores. Only to force a new API Gateway deployment. |

## First deployment

1. An administrator creates the external permissions boundary `arturia-pilot-boundary` from [`boundaryPolicy()`](../infra/delivery.ts), then synthesizes and deploys the foundation. Set `BUDGET_ALERT_EMAIL` to the budget recipient.

   ```bash
   npm run synth:foundation
   npx cdk deploy --app cdk.foundation.out --parameters "BudgetAlertEmail=$BUDGET_ALERT_EMAIL"
   ```

2. Activate `Project` as a cost allocation tag and attach the `arturia-pilot-operator` managed policy to the deploying principal's permission set. For `catalog`, the administrator also creates the [provider credential](security.md#provider-credentials).
3. Run `npm run build` in the web checkout. From the API checkout, set `ACCOUNT` and `REGION` to the deployment target, `PARTITION` to its ARN partition (`aws` for standard regions), `ALERT_EMAIL` to the pilot alarm recipient and `COGNITO_DOMAIN_PREFIX` to an available Cognito domain prefix. With the operator's credentials, synthesize and deploy the pilot.

   ```bash
   ARTURIA_WEB_DIR=../arturia npm run synth:pilot -- \
     -c "arturia:account=$ACCOUNT" -c "arturia:region=$REGION" -c arturia:workerPaused=false
   npx cdk deploy --app cdk.pilot.out \
     --role-arn "arn:$PARTITION:iam::$ACCOUNT:role/arturia-pilot-cloudformation" \
     --parameters "AlertEmail=$ALERT_EMAIL" \
     --parameters "CognitoDomainPrefix=$COGNITO_DOMAIN_PREFIX"
   ```

4. Confirm the alarm subscription email. Create a user in the Cognito user pool and [provision their Arturia account](operations.md#new-user). In `fixture` mode, run the [SSE smoke test](operations.md#operator-scripts) against the stage URL.

Omitting `arturia:providerMode` deploys the non-billable `fixture` mode; `catalog` is an explicit choice.

## Updates and rollback

Every change, including the provider mode and the kill switch, is a new synthesis plus deployment; there are no runtime toggles. To roll back, synthesize the previous revision with the same context and deploy it again. Web assets are never pruned, so open tabs and a rolled-back `index.html` keep finding their chunks; `config.json` is regenerated from the stack.

To stop new model calls, follow the [worker kill switch](operations.md#worker-kill-switch) procedure.

## Forcing a new API deployment

API Gateway serves a snapshot of its configuration: preflight, gateway response and method changes reach the stage only through a new deployment. CDK derives the deployment's logical ID from the configuration as written in the template, not from the values CloudFormation resolves.

- The CORS origin therefore comes from the distribution (`Fn::GetAtt`) and never from a stack parameter, an import or a dynamic reference, which a test enforces. Replacing the distribution means a new logical ID, and so a new deployment. CloudFront never replaces a distribution on update, so its domain cannot change under the same logical ID.
- The pilot enables `@aws-cdk/aws-apigateway:authorizerChangeDeploymentLogicalId`, so authorizer changes produce a new deployment.
- A value that changes outside the template leaves the stage on the old deployment: an out-of-band replacement, an imported resource, or a user pool replaced under the same logical ID, which the authorizer references by ARN.

To recover, synthesize with `-c arturia:apiRedeploy=<value>`, using any value different from the previous one, and deploy again: the stage moves to a new deployment and nothing else changes. Prefer this to `aws apigateway create-deployment`, which leaves the stage outside CloudFormation.

## Deleting the pilot

Empty the web bucket before deleting the pilot stack. Review [which resources are deleted or retained](infrastructure.md#retention-and-deletion) first.
