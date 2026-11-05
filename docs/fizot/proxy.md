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

Before a call is forwarded the proxy reserves `max_tokens × output price + input estimate`. If the balance minus open reservations is below that reserve, the proxy returns `402 { "error": "insufficient_credit" }` and does not call the provider. After a successful answer it writes one `usage` row for the provider's token counts, or for the reserved amount when usage is missing, and releases the reservation. A provider `5xx` releases the reservation and writes no usage row. The same `request_id` returns the stored result and does not charge again; a second call while the first is still running returns `409`.

At 80% of included credit for the UTC month the proxy writes one alert for that period and posts it on the existing alert webhook when `FIZOT_ALERT_WEBHOOK_URL` is set. The body has the workspace id hash, the period, and the micro-GBP figures, not an email and not the prompt.

`FIZOT_PROXY_DISABLED=1` and `POST /admin/proxy/kill` (header `x-fizot-admin-secret`) stop provider traffic on the next request. `POST /admin/workspaces/:id/credit/grants` uses the same secret. `GET /admin/workspaces/:id/credit` is member+ and returns balance and period usage only.

Ledger rows are append-only (trigger rejects `UPDATE` and `DELETE`). `scripts/fizot/ledger-reconcile.mjs` compares a ledger total with a provider fixture and fails when drift is over 1%.
