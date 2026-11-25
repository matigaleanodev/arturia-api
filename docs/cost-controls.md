# Cost controls

[Español](cost-controls.es.md)

Spending is bounded in layers: a safe provider mode by default, a hard monthly ledger checked before every model send, request throttling, bounded concurrency and capacity, and an AWS budget that alerts but never stops spending.

## Provider modes

`ARTURIA_PROVIDER_MODE` accepts `fixture`, `fail` and `catalog`, and only with `ARTURIA_ENVIRONMENT=pilot`:

- `fixture` emits three synthetic blocks one second apart.
- `fail` never runs the turn, so the message reaches the dead-letter queue.
- `catalog` is the only billable mode. It accepts only the providers and models enabled in [`src/config/catalog-config.ts`](../src/config/catalog-config.ts). OpenAI is currently the only enabled provider.

`-c arturia:providerMode=fixture|fail|catalog` sets the mode at synthesis without code changes; changing it only changes the worker's environment. Without the context the worker runs `fixture`, so a deployment that omits it returns to the safe mode. Any other value fails the synthesis. `catalog` also requires `-c arturia:model=<model>` and `-c arturia:tariffVerifiedAt=<YYYY-MM-DD>`.

## Spending ledger

A dedicated ledger table (`arturia-pilot-ledger`) owns the deployment budget. It belongs to the foundation, not to the pilot stack: it is retained and has deletion protection and point-in-time recovery, so destroying or recreating the pilot cannot reset the monthly consumption. The worker reaches it through `ARTURIA_LEDGER_TABLE_NAME`, and the runtime refuses a ledger name equal to the chat table.

- Each attempt reserves against both the US$10 UTC calendar-month ceiling and the configured provider ceiling.
- Amounts use integer microdollars (1 USD = 1,000,000 µUSD). Token rates use µUSD per million tokens, with one upward rounding after summing all token costs.
- The transport supplies a verified upper bound for the entire encoded input and enforces limits for visible output, reasoning, tool arguments and separately billed tool calls. Token buckets are disjoint.
- Missing or expired prices disable new sends.
- The ledger records the applied tariff, provider, model, operation, usage and cost.
- Redelivery cannot reuse a reservation. A per-turn guard written in the same transaction allows a single reservation per turn, even when a redrive outside the queue's deduplication window starts a new attempt. Each subsequent authorized attempt needs a new ID, and a transport must disable implicit retries.
- A confirmed final usage report or invoice reconciles the original month exactly once. A timeout, interrupted stream or missing report retains the full reservation.
- An uncertain reservation is never released automatically: an operator settles it only against the provider's exported invoice or usage ([Operations](operations.md#uncertain-model-reservations)).

## Per-attempt limits

Each attempt reserves the cost bound of the exact limits it sends:

- Output: the model's output cap (4096 tokens in the pilot, never above 128,000).
- Input: the model's context window, or the message's UTF-8 bytes plus the provider's framing once a calibration measured with the provider's own token counter exists for that model. A calibration contradicted by one of its own samples is rejected.
- A message above 393,216 bytes is refused before any reservation.
- If the provider reports more input tokens than the reserved bound, the attempt is marked failed and the reported charge is settled.
- A provider ceiling below the bound of a single attempt is a configuration error: `checkCatalogConfig` reports it at startup together with how many uncertain attempts exhaust the month, and the reservation refuses the send otherwise.

## Throttling and capacity

- Stage throttling targets 10 requests per second with a burst of 20 per method. Accepted turns are limited to 1/5 and SSE to 1/4, which keeps concurrent streaming functions within 33. Values live in [`infra/chat-api.ts`](../infra/chat-api.ts).
- API Gateway applies these limits per method and on a best-effort basis, and answers `429 RATE_LIMITED` with the public error shape.
- Reserved concurrency for SSE is off unless configured, and then must cover every stream the throttle admits.
- The worker's event source has a maximum concurrency of 2.
- The on-demand table caps read and write request units per second (`TABLE_LIMITS` in [`infra/cost-controls.ts`](../infra/cost-controls.ts), with the expected peak calculation).
- An alarm fires at 2,000 or more API requests per hour ([Operations](operations.md#alarms)).

## AWS budget

The foundation's `arturia-aws-monthly` budget ([`infra/cost-controls.ts`](../infra/cost-controls.ts)) is US$10 per month, filters on the `Project=arturia` cost allocation tag and emails `BudgetAlertEmail` at US$5 and US$8 of actual spend and US$10 forecasted. It excludes credits and refunds.

- It has no actions: it alerts with billing delay and never stops spending. To stop model sends, use the [worker kill switch](operations.md#worker-kill-switch).
- The tag must be activated as a cost allocation tag before the budget sees it, and charges that cannot be tagged fall outside the filter.
