# Fizot AI proxy

The proxy holds Fizot's provider keys and meters each workspace in integer micro-GBP. A machine presents the short-lived `omb_ai_` token Admin minted for that workspace. It never receives a provider key, and it names a tier rather than a provider model.

Prices below are **placeholders**. They have not been checked against a provider price page. `priceStatus` is `placeholder_unverified` until that check is written down.

| Tier (customer) | Internal provider | Internal model | Input micro-GBP / 1M tokens | Output micro-GBP / 1M tokens | Markup |
| --- | --- | --- | --- | --- | --- |
| Fast | xai | grok-4-fast | 200000 | 800000 | 20% (2000 bps) |
| Balanced | xai | grok-4 | 800000 | 3200000 | 20% (2000 bps) |
| Best | xai | grok-4-heavy | 2000000 | 8000000 | 20% (2000 bps) |

Customer micro-GBP is `ceil(tokens × microGbpPerMillion × (10000 + markupBps) / 1_000_000 / 10000)`. No floats.

Included credit used for the monthly 80% alert (also a placeholder, not a published plan price): Home £5 (5_000_000 micro-GBP), Team £20 (20_000_000). Top-ups are extra `grant` rows. The balance is the sum of the ledger. The hard cap is that balance, which is included credit plus grants minus usage.

Before a call is forwarded the proxy reserves `max_tokens × output price + input estimate`. If the balance minus open reservations is below that reserve, the proxy returns `402 { "error": "insufficient_credit" }` and does not call the provider. After a successful answer it writes one `usage` row for the provider's token counts, or for the reserved amount when usage is missing, and releases the reservation. A provider `5xx` releases the reservation and writes no usage row. The same `request_id` with the same workspace, tier and exact request payload does not call the provider or charge twice. Because model responses must not be persisted in the Admin credit database, a completed replay returns `409 {"error":"request_already_completed"}` rather than a cached answer; an in-flight repeat returns `409 {"error":"in_flight"}`. A request ID reused by another workspace or with a different payload/quoted reservation returns `409 {"error":"idempotency_conflict"}`, without any prior response or ownership metadata. The storage schema keeps globally unique legacy request IDs for compatibility; a collision is rejected, not namespaced automatically.

At 80% of included credit for the UTC month the proxy writes one alert for that period and posts it on the existing alert webhook when `FIZOT_ALERT_WEBHOOK_URL` is set. The body has the workspace id hash, the period, and the micro-GBP figures, not an email and not the prompt.

`FIZOT_PROXY_DISABLED=1` and `POST /admin/proxy/kill` (header `x-fizot-admin-secret`) stop provider traffic on the next request. `POST /admin/workspaces/:id/credit/grants` uses the same secret. `GET /admin/workspaces/:id/credit` is member+ and returns balance and period usage only.

Ledger rows are append-only (trigger rejects `UPDATE` and `DELETE`). `scripts/fizot/ledger-reconcile.mjs` compares a ledger total with a provider fixture and fails when drift is over 1%.

## Privacy and idempotency deployment requirements (P4.3 work package 1)

- Credit-enabled proxy startup requires `FIZOT_PROXY_IDEMPOTENCY_HMAC_SECRET` (at least 32 UTF-8 bytes), configured through secret storage, identical across all proxy replicas and restarts. Never store the secret in Git or pass it to the sandbox. Missing/short secret fails startup closed. Keep it stable across restarts so retries can be checked against the original HMAC.
- An HMAC-SHA-256 fingerprint binds each reservation to its originating workspace, selected tier and exact request body. Only the opaque fingerprint is stored. Raw request and completed response bodies are not saved in new credit reservation records. The proxy accepts bounded `x-request-id` values (1–128 characters: letters, digits, dot, underscore, colon and hyphen); absent IDs use a fresh UUID. Incoming request bodies are limited to 1 MiB.
- **Behavior change:** a completed idempotent retry is monetarily safe, but does not replay the model response. Clients must treat `request_already_completed` as a terminal outcome, not retry with a different ID automatically. This may require a later short-lived encrypted replay cache at the proxy edge if transparent retries are required.
- This PR deliberately does **not** drop the existing legacy `response_body`/`content_type` columns or purge historical response data in a live Admin Postgres database. It stops new writes and makes new databases omit these columns. Review any existing historical records and obtain operator approval for a privacy purge/migration before enabling production.
- Future P4.3 work must migrate global request-ID uniqueness safely if tenant-scoped namespace reuse is required; implement 12-month credit expiry, stale reservation recovery, bounded actual-usage settlement, verified provider pricing and real J4 reconciliation. Passing this PR alone does not close P4.3/G4.
