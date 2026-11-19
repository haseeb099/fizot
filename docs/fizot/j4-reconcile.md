# J4 provider↔ledger reconciliation runbook

Read-only procedure. Does **not** charge, refund, settle, or release holds. Does **not** prove J4 PASS from synthetic fixtures alone.

## Comparison basis

J4 drift uses **provider cost vs Fizot-computed provider cost** (same micro-units, usually micro-USD):

`drift = abs(fizotProviderCost − providerBilledCost) / abs(providerBilledCost)`

Acceptance threshold: **≤ 1%** (`RECONCILE_MAX_DRIFT`).

**Do not** compare provider USD cost directly to customer micro-GBP ledger debits. Customer charges include markup (`markupBps` in `pricing.ts`) and use placeholder GBP rates until prices are verified and FX is operator-approved.

Customer charges are reported separately for investigation only.

## Prerequisites

1. Operator access to the xAI billing/usage export for the reconciliation period (console CSV/API). Prefer rows that include a request or usage id Fizot can match.
2. Redacted Fizot ledger/reservation export for the same period: workspace id **hashes** only, request ids, tiers, token counts, customer charge micro-GBP, and Fizot-computed provider cost when convertible.
3. List of open `uncertain` / `quarantined` reservations (request id, workspace hash, amount, status).
4. No production mutations, no Stripe, no Admin migrations during the run.

## Obtain provider billing evidence

1. Export usage for the period from the xAI console (or invoice line detail).
2. Keep currency as billed (USD). Convert only with an operator-approved FX rate if a GBP provider-cost column is required; record the rate and timestamp in the export meta.
3. Redact prompts, completions, and API keys before the file leaves the billing workstation.
4. If the export lacks Fizot `request_id` correlation, document the matching limitation. Do **not** invent joins.

## Export Fizot ledger evidence

Safe query shape (illustrative; run against a read replica or offline dump):

- Ledger `usage` rows: `request_id`, `workspace_id` hashed client-side, amount, token meta, `fundingAuthorizedAtMs`.
- Open reservations: statuses `reserved` | `dispatched` | `uncertain` | `quarantined`.
- Never select raw prompt/response bodies or provider API keys.
- Filter to one workspace hash when investigating a single tenant.

Compute Fizot provider cost with `quoteProviderCostMicroUsd` / observed rates in `pricing-verification.ts` when the internal model maps to a verified provider row. If the mapping is still `mismatched_unverified`, mark `evidenceComplete: false`.

## Run reconciliation

```bash
node --experimental-strip-types scripts/fizot/j4-reconcile.mjs path/to/export.json
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | `PASS` |
| 1 | `FAIL` |
| 3 | `INSUFFICIENT_EVIDENCE` |
| 2 | usage / parse error |

Totals-only fixture path (legacy): `scripts/fizot/ledger-reconcile.mjs` — still fixture drift only; not J4 acceptance.

## Investigate unmatched records

1. **Unmatched provider rows** — billed by xAI, no Fizot ledger match. Check quarantine/uncertain holds, clock skew on period bounds, missing `fizotRequestId` in the export join.
2. **Unmatched ledger rows** — Fizot charged customer (or reserved) without provider evidence. Confirm settle used `reserved_missing_usage` or clamp; pull provider side by time window.
3. **Duplicates** — fail closed; fix the export before re-running.
4. **Drift > 1% on matched provider cost** — check token parsing (`prompt_tokens` / `completion_tokens`), cached-input / long-context / priority / regional multipliers, and whether customer markup was accidentally mixed into the provider-cost column.

## Uncertain / quarantined holds

1. Leave funds held. Do **not** auto-release or auto-settle from this tool.
2. Match against late provider usage. If a verified provider response exists, settle through the normal idempotent settle path with operator approval.
3. If the provider confirms no charge, release only via an explicit authorized operator action (out of band from this script).
4. Pre-production upgrade: drain or reconcile any open reservations with empty `funding` before enabling Admin traffic that depends on authorize-time slices.

## Escalation and audit trail

1. Preserve the input export (redacted), CLI stdout JSON, git SHA of the reconciler, and operator identity/time.
2. Unexplained drift or unmatched billable rows → escalate as P0 financial risk; block G4 / P4.3 close.
3. Never mark J4 PASS without real provider billing evidence for the stated period.

## Known limitations

- Internal models `grok-4-fast`, `grok-4`, `grok-4-heavy` remain **mismatched_unverified** against the live xAI catalog (see `pricing-verification.ts`). Redirected retired slugs bill at `grok-4.3` rates after 2026-05-15.
- Cached input, reasoning tokens, tools, batch, priority, and US-regional multipliers are not yet first-class in the customer meter; treat them as provider-side variance sources.
- Synthetic fixtures in `tests/fizot/proxy/fixtures/j4-*.json` prove the tool only.
