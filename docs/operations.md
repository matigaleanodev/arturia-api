# Operations

[Español](operations.es.md)

## Alarms

The `arturia-pilot-alerts` topic sends alarms to the address in `AlertEmail`. Confirm the subscription from the email message. The topic is not encrypted with the AWS managed key, which CloudWatch cannot publish to.

Every alarm fires on a single datapoint. Thresholds live in [`infra/observability.ts`](../infra/observability.ts):

- Visible messages in each dead-letter queue, and turn dead-letter queue age (7 days).
- Relay `IteratorAge` (5 min) and turn queue age (10 min).
- `Errors` of the HTTP, SSE, worker and relay functions; `Throttles` of HTTP and SSE.
- Stage `5XXError`, and 2,000 or more requests per hour.

A worker failure returned as `batchItemFailures` does not raise `Errors`: queue age and the dead-letter queue catch it. SQS stops publishing metrics for a queue without activity for six hours, so the dead-letter queue alarms keep their state when data is missing.

## Worker kill switch

`-c arturia:workerPaused=true` plus a deployment disables the worker's event source mapping. New queue messages wait for delivery (up to 14 days). Invocations already in progress can still finish. `false` resumes it. The deployable synthesis requires the context (`true` or `false`), so a deployment cannot resume a paused worker by omission.

To return to the non-billable mode without pausing, set `-c arturia:providerMode=fixture` or omit that setting. Remove `arturia:model` and `arturia:tariffVerifiedAt` from the context, then synthesize and deploy. See [Cost controls](cost-controls.md#provider-modes).

## Operator scripts

[`src/admin/`](../src/admin/) holds the administrative operations. The scripts compile first and print one JSON line. The Cognito subject is masked in the output. A synthetic identity mode or an SDK endpoint override aborts the script. Commands that access DynamoDB require `--region`, `--profile` and `--expected-account` (written below as `<target>`). Commands that access the chat table also require `--table` with its name. The scripts verify each table ARN before accessing its data.

| Command | Purpose |
| --- | --- |
| `npm run provision:pilot -- --sub <sub>` | Dry run. Lists the rows it would ensure without reading or writing anything. |
| `... --check --table <chat> <target>` | Read-only. Reports `absent`, `partial`, `complete` or `conflict`, plus the presence of model grants. Exits with 2 unless the state is complete. |
| `... --apply --confirm-totp-enrolled --table <chat> <target>` | Creates the missing `SUBJECT`, `ACCOUNT` (active, `mfaVerifiedAt` = now + 60 s, a margin against a local clock behind AWS) and the `personal` and `work` `SCOPE` rows in one transaction. Existing rows are never modified. A disabled account, different scope actions or an invalid mapping stop the run before any write. Model grants are not written unless `--model-grants` is added. |
| `... --apply --before-first-login --table <chat> <target>` | Same as above for a person who has not signed in yet (no token exists before TOTP is enrolled): `mfaVerifiedAt` = now - 60 s, so the sign-in that enrolls TOTP is accepted at once. Exclusive with `--confirm-totp-enrolled`. |
| `... --apply ... --model-grants` | After a complete provision, also writes the OpenAI model grant of the `personal` scope if absent. An identical row is a no-op; a different one is a conflict resolved by hand. |
| `npm run republish:outbox -- --sub <sub> --table <chat> <target>` | Read-only listing of the user's pending outbox intents (`--scope` narrows it). |
| `... --apply --queue-url <url>` | Publishes each pending intent to the FIFO turn queue (`*turns.fifo`, never the dead-letter queue) of the same account and region, then marks it. Stops at the first failure and leaves the rest pending. A duplicate is harmless: the worker claims the durable turn by ID. |
| `npm run settle:attempts -- --all-users --month YYYY-MM --ledger-table <ledger> <target>` | Read-only listing of uncertain model reservations in one UTC month. To select one user, replace `--all-users` with `--sub <sub> --table <chat>`. `--scope` narrows the results. |
| `... --evidence <file>` | Dry run. Matches the exported invoice or usage (`{month, entries: [{attemptId, costMicros, reference}]}`) to reservations. Unmatched attempts keep their reservation. Exits with 2 when an entry cannot be matched. |
| `... --evidence <file> --apply` | Settles only the matched attempts, once, with an audit row. Repeating it changes nothing. |
| `npm run pilot:inspect -- --sub <sub> --table <chat> <target> --turn <id> --scope <id>` | Read-only. Status, started attempts (`claims`), send state and outbox state of one turn, without its content. |
| `npm run pilot:inspect -- --sub <sub> --table <chat> <target> --stale [--older-than-minutes <n>]` | Read-only. The user's `queued` or `running` turns accepted more than `n` minutes ago (default 60, 15 to 20160), with their outbox state. Exits with 2 when there are any. |
| `npm run smoke:sse:aws` | SSE smoke test for a deployed pilot in `fixture` mode. Set `ARTURIA_SMOKE_API_URL` to the HTTPS stage URL and `ARTURIA_SMOKE_ACCESS_TOKEN` to a test user's access token. It creates a synthetic conversation and turn, cuts the connection after the first block and resumes by cursor. It writes no files and prints neither token nor URL. Optional settings are defined in [`src/smoke/sse-smoke.ts`](../src/smoke/sse-smoke.ts). |

## Recovery procedures

### New user

Self-sign-up is disabled. Create the user in Cognito and use their `sub` for provisioning. Run `provision:pilot` with `--apply --before-first-login` before the person's first sign-in, or with `--apply --confirm-totp-enrolled` once TOTP is enrolled, and confirm with `--check`. After `--confirm-totp-enrolled`, wait more than a minute and sign in again: sessions authenticated before `mfaVerifiedAt` are rejected. Model grants are a separate, explicit step (`--model-grants`).

### Stuck turns

Find them with `pilot:inspect --stale`, then inspect each one with `--turn`. A turn whose outbox intent is still pending is published again with `republish:outbox --apply`.

### Dead-letter queues

- **Turn dead-letter queue:** its messages already have a published outbox row. Recover them with an SQS redrive to the turn queue, not with `republish:outbox`.
- **Relay dead-letter queue:** it holds stream batch metadata only. Recover its turns with `republish:outbox`.

### Uncertain model reservations

A timeout, interrupted stream or missing usage report leaves the reservation in place. List the month's uncertain attempts with `settle:attempts`, export the invoice or usage from the provider, run the dry run with `--evidence` and apply it once every entry matches. Use `--all-users` when the chat table was recreated. The listing omits reservations younger than `MIN_UNCERTAIN_AGE_SECONDS` in [the settlement code](../src/models/settlement-admin.ts). Evidence for those reservations is rejected as `too-recent`.

### Stale API Gateway deployment

See [Deployment](deployment.md#forcing-a-new-api-deployment).
