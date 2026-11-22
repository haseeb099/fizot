# Fizot AI proxy

The proxy holds Fizot's provider keys and meters each workspace in integer micro-GBP. A machine presents the short-lived `omb_ai_` token Admin minted for that workspace. It never receives a provider key, and it names a tier rather than a provider model.

Prices below are **placeholders**. They have not been checked against a provider price page. `priceStatus` is `placeholder_unverified` until that check is written down.

| Tier (customer) | Internal provider | Internal model | Input micro-GBP / 1M tokens | Output micro-GBP / 1M tokens | Markup |
| --- | --- | --- | --- | --- | --- |
| Fast | xai | grok-4-fast | 200000 | 800000 | 20% (2000 bps) |
| Balanced | xai | grok-4 | 800000 | 3200000 | 20% (2000 bps) |
| Best | xai | grok-4-heavy | 2000000 | 8000000 | 20% (2000 bps) |

Customer micro-GBP is `ceil(tokens × microGbpPerMillion × (10000 + markupBps) / 1_000_000 / 10000)`. No floats.

Included credit used for the monthly 80% alert (also a placeholder, not a published plan price): Home £5 (5_000_000 micro-GBP), Team £20 (20_000_000). Top-ups are extra `grant` rows.

### Spendable balance and 100% hard cap

Spendable balance uses a shared chronological allocator: each `usage` / negative `adjust` is applied against FIFO lots that are still valid **at that debit's effective funding time** (`expires_at` null or strictly after). Usage effective time is `fundingAuthorizedAtMs` (reservation authorize time) when present, otherwise the ledger `created_at`. A grant that has already expired at authorize time cannot absorb that usage. Compensating `expire` ledger rows are append-only audit (idempotent `expire:{grantId}`) and do not double-consume. Uncovered historical debits fail closed (`uncovered_debit`).

Reserve binds auditable funding slices at authorize time (`planFundingSlices`), applying every open hold so two active reservations cannot claim the same grant residual even when workspace `spendable − reserved` still admits both. Settle writes charge-scaled slices plus `fundingAuthorizedAtMs` into usage meta; later allocation consumes those slices (not a fresh FIFO pass). Open holding reservations (`reserved`, `dispatched`, `uncertain`, `quarantined`) subtract from available credit and reduce expire residuals for their bound lots so early `expireDue` cannot over-audit escrowed credit. Concurrent reserves take a workspace advisory lock (Postgres) or an in-process mutex lock (memory). No workspace can reserve more than spendable − reserved, and no grant lot can be over-held. `grant`/`refund` amounts must be strictly positive safe integers; `adjust` must be a non-zero safe integer.

Settlement never debits more than the reservation. When provider-reported usage quotes above the reserved micro-GBP, the ledger writes `min(actual, reserved)` and records `cappedToReservation: true` in meta. **Remaining exposure:** Fizot still owes the upstream provider the true token cost when actual usage exceeds the reserved estimate; the customer ledger does not silently invent extra balance. Operators must size `max_tokens` / estimates and monitor `cappedToReservation` drift (J4). Missing, negative, non-integer, or absurd token counts cannot undercharge: the meter settles the full reservation instead. Malformed or oversized `max_tokens` / `max_completion_tokens` (above 128_000) return `400` before reserve.

### Reservation recovery

Released request IDs (same workspace, fingerprint and amount) may be reauthorized: created_at stays the first insert while authorized_at becomes the new funding clock used for fundingAuthorizedAtMs and open-hold expiry. Settled IDs remain replay-only.

Lifecycle: `reserved` (held, not forwarded) → atomic checked `dispatched` (only then may the provider be called) → `settled` / `released`, or `uncertain` when the post-dispatch outcome is ambiguous, then `quarantined` after grace. `markDispatched` is a locked reserved→dispatched transition with `RETURNING` / status check; failure returns `409 reservation_unavailable` and **must not** forward. Recovery racing before dispatch can release a still-`reserved` hold; the meter then refuses the provider call.

After dispatch, timeouts, transport/network errors, and HTTP `5xx` mark `uncertain` (hold/quarantine path) because the provider may still have billed — they are not released. Pre-dispatch failures never reach the provider. `recoverStaleReservations` after `RESERVATION_RECOVERY_GRACE_MS` from `updated_at`: undelivered `reserved` → **release** (no fabricated usage); `dispatched`/`uncertain` → **quarantine** (funds stay held; no usage debit). Quarantined rows may still settle idempotently when a late verified provider response arrives. Age-only settlement of unconfirmed work is intentionally not used. Operator/J4 reconcile is required before releasing quarantined holds when the provider outcome remains unknown.

### 12-month credit expiry

New positive `grant`, `refund`, and positive `adjust` rows get `expires_at = grant_time + 12 UTC calendar months` (day clamped for shorter months / leap years). Consumption order is oldest lot first (FIFO). Expiry writes an append-only compensating `expire` ledger row with idempotent `request_id = expire:{grantId}`; historical grant rows are never mutated or deleted. Legacy rows with `expires_at IS NULL` are grandfathered and do not auto-expire until an operator-approved migration sets expiry (blocked step: no silent balance reduction). Subscription included credits from `invoice.paid` use the same 12-month clock. Concurrent `expireDue` workers are idempotent via the unique expire request id.

Before a call is forwarded the proxy reserves `max_tokens × output price + input estimate`. If spendable minus open reservations is below that reserve, the proxy returns `402 { "error": "insufficient_credit" }` and does not call the provider. After a successful answer it writes one `usage` row for the provider's token counts, or for the reserved amount when usage is missing, capped to the reservation. The same `request_id` with the same workspace, tier and exact request payload does not call the provider or charge twice. Because model responses must not be persisted in the Admin credit database, a completed replay returns `409 {"error":"request_already_completed"}` rather than a cached answer; an in-flight repeat returns `409 {"error":"in_flight"}`. A request ID reused by another workspace or with a different payload/quoted reservation returns `409 {"error":"idempotency_conflict"}`, without any prior response or ownership metadata. The storage schema keeps globally unique legacy request IDs for compatibility; a collision is rejected, not namespaced automatically.

At 80% of included credit for the UTC month the proxy writes one alert for that period and posts it on the existing alert webhook when `FIZOT_ALERT_WEBHOOK_URL` is set. The body has the workspace id hash, the period, and the micro-GBP figures, not an email and not the prompt.

`FIZOT_PROXY_DISABLED=1` and `POST /admin/proxy/kill` (header `x-fizot-admin-secret`) stop provider traffic on the next request. `POST /admin/workspaces/:id/credit/grants` uses the same secret. `GET /admin/workspaces/:id/credit` is member+ and returns balance and period usage only.

Ledger rows are append-only (trigger rejects `UPDATE` and `DELETE`). `scripts/fizot/ledger-reconcile.mjs` compares a ledger total with a provider fixture and fails when drift is over 1%. Row-level J4 reconciliation is `scripts/fizot/j4-reconcile.mjs` (provider cost vs Fizot provider cost; multi-dimension match; per-request material drift exception; structured evidence package — see `docs/fizot/j4-reconcile.md`). Customer markup charges are reported separately and must not be compared directly to provider USD. Legacy `evidenceComplete: true` alone cannot produce an acceptance-grade PASS.

### Provider price verification (not yet customer pricing)

Customer tier rates in the table above remain `placeholder_unverified`. Observations against the live xAI pricing page (2026-11-19) are recorded in `server/fizot/proxy/pricing-verification.ts`:

| Internal model | Live catalog match | Status |
| --- | --- | --- |
| grok-4-fast | No live row; retired fast slugs redirect to grok-4.3 | mismatched_unverified |
| grok-4 | No live row; retired grok-4-0709 redirects to grok-4.3 | mismatched_unverified |
| grok-4-heavy | No live listing | mismatched_unverified |

Observed short-context `grok-4.3` rates (USD / 1M tokens): input $1.25, cached input $0.20, output $2.50. Source: https://docs.x.ai/developers/pricing. Customer micro-GBP placeholders are **not** silently updated from these observations.

## Privacy and idempotency deployment requirements (P4.3 work package 1)

- Credit-enabled proxy startup requires `FIZOT_PROXY_IDEMPOTENCY_HMAC_SECRET` (at least 32 UTF-8 bytes), configured through secret storage, identical across all proxy replicas and restarts. Never store the secret in Git or pass it to the sandbox. Missing/short secret fails startup closed. Keep it stable across restarts so retries can be checked against the original HMAC.
- An HMAC-SHA-256 fingerprint binds each reservation to its originating workspace, selected tier and exact request body. Only the opaque fingerprint is stored. Raw request and completed response bodies are not saved in new credit reservation records. The proxy accepts bounded `x-request-id` values (1–128 characters: letters, digits, dot, underscore, colon and hyphen); absent IDs use a fresh UUID. Incoming request bodies are limited to 1 MiB.
- **Behavior change:** a completed idempotent retry is monetarily safe, but does not replay the model response. Clients must treat `request_already_completed` as a terminal outcome, not retry with a different ID automatically. This may require a later short-lived encrypted replay cache at the proxy edge if transparent retries are required.
- This PR deliberately does **not** drop the existing legacy `response_body`/`content_type` columns or purge historical response data in a live Admin Postgres database. It stops new writes and makes new databases omit these columns. Review any existing historical records and obtain operator approval for a privacy purge/migration before enabling production.
- Work package 2 adds hard-cap settlement clamping, uncertain/stale reservation recovery, and append-only 12-month expiry (see above). Remaining before P4.3 / G4 close: operator-approved verified customer prices (observations exist but tiers stay placeholder), real provider-billing J4 evidence (tooling exists; fixtures alone are insufficient), optional tenant-scoped request-ID namespace migration, and operator approval before any legacy `expires_at IS NULL` balance migration. Passing this PR alone does not close P4.3/G4.
