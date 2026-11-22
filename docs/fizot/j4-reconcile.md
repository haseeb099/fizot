# J4 provider↔ledger reconciliation runbook

Read-only procedure. Does **not** charge, refund, settle, or release holds. Does **not** prove J4 PASS from synthetic fixtures alone.

## Comparison basis (official J4 aggregate metric)

J4 aggregate drift uses **provider cost vs Fizot-computed provider cost** (same micro-units, usually micro-USD):

`aggregateDrift = abs(sum(fizotProviderCost) − sum(providerBilledCost)) / abs(sum(providerBilledCost))`

Acceptance threshold for that aggregate metric: **≤ 1%** (`RECONCILE_MAX_DRIFT`).

**Do not** compare provider USD cost directly to customer micro-GBP ledger debits. Customer charges include markup (`markupBps` in `pricing.ts`) and use placeholder GBP rates until prices are verified and FX is operator-approved.

Customer charges are reported separately for investigation only.

## Blocking exception: material per-request discrepancies

Offsetting errors must not disappear behind a clean aggregate. The reconciler also reports:

| Field | Meaning |
| --- | --- |
| `signedVarianceMicro` | per request: fizot − provider |
| `absoluteVarianceMicro` | per request: abs(signed) |
| `drift` | per request: abs(signed) / provider (or 1 if provider is 0 and fizot ≠ 0) |
| `aggregateSignedVarianceMicro` | sum of signed variances (can cancel) |
| `aggregateAbsoluteVarianceMicro` | sum of absolute variances (cannot cancel) |
| `maxPerRequestDrift` | worst per-request drift |
| `materialPerRequestCount` | rows with per-request drift **>** 1% |
| `discrepancyExposureMicro` | = aggregate absolute variance |

**Policy:** any matched row with per-request drift **> 1%** is a material discrepancy. The run **must not PASS** solely because aggregate drift ≤ 1%. Reason: `material_per_request_discrepancies`. The official aggregate ≤1% criterion remains documented and reported as `withinThreshold`; the per-request rule is an additional blocking exception.

## Matching rules

Provider and ledger rows are candidates only when `provider.fizotRequestId === ledger.requestId`. A shared request id is **not** a financial match by itself.

Every candidate is checked on:

1. Workspace/tenant hash — both required; inequality → `workspace_mismatch`; either missing → `workspace_identity_unavailable`.
2. Provider model — `ledger.providerModel` must equal `provider.model`; null → `provider_model_identity_unavailable`.
3. Currency — must be identical; mixed currencies in one run are refused.
4. Token counts — both ledger sides required; inequality → `token_count_mismatch`; null → `token_identity_unavailable`.
5. Provider cost on the ledger — required for a cost match.
6. Provider request id — required (non-null) for a dimension-valid match; duplicates fail closed.

Missing identity is never treated as equality. Do **not** invent provider↔Fizot request-id joins. Dimension failures go to `mismatched` (with reasons), not `matched`.

## Evidence package (required)

A legacy boolean `evidenceComplete: true` alone yields **`INSUFFICIENT_EVIDENCE`**. Supply a structured `evidence` object:

| Field | Role |
| --- | --- |
| `evidenceClass` | `synthetic_fixture` (tool integrity only) or `operator_export` |
| `periodStartUtc` / `periodEndUtc` | Reconciliation window |
| `providerExportSource` + `providerExportGeneratedAtUtc` | Provenance |
| `providerBillingScopeHash` | Redacted/hashed billing scope — never raw secrets |
| `providerExportRecordCount` / `providerExportTotalBilledMicro` | Must equal input rows / sum of provider costs |
| `ledgerExportSource` + timestamp + `ledgerExportRecordCount` | Must equal ledger row count |
| `pricingVerificationStatus` | Must not claim `verified` while observations are unverified |
| `currency` / `conversionBasis` | Single currency; FX basis if any |
| `correlationMethod` | `fizot_request_id_with_dimension_checks` |
| `knownCoverageGaps` | Explicit gaps; non-empty blocks completeness attestation |
| `operatorAttestation` | Who/when/statement |
| `operatorAttestsComplete` | Operator claim only |

### Evidence assessment

The report distinguishes:

- **Structurally valid** — counts, totals, currencies, period bounds and attestation fields agree with the payload.
- **Operator-attested complete** — `operatorAttestsComplete` and empty `knownCoverageGaps`.
- **Independently verifiable** — always **false** in this tool (it only sees operator-supplied files).
- **Acceptance eligible** — always **false** here until an independent verifier exists.

Verdict rules:

| Situation | Verdict |
| --- | --- |
| Missing/invalid evidence package, or boolean-only | `INSUFFICIENT_EVIDENCE` |
| Structurally valid + reconcile dirty (unmatched, mismatch, material drift, duplicates, holds, mixed currency) | `FAIL` |
| `synthetic_fixture` structurally valid + clean reconcile | `PASS` (**tool integrity only**) |
| `operator_export` even when structurally clean | `INSUFFICIENT_EVIDENCE` (not independently verifiable) |

**Synthetic tool PASS ≠ J4 acceptance.** Real J4 remains **INSUFFICIENT EVIDENCE** without independently verified provider billing evidence.

## Prerequisites

1. Operator access to the xAI billing/usage export for the period.
2. Redacted Fizot ledger export (workspace **hashes** only).
3. Open `uncertain` / `quarantined` holds list.
4. No production mutations, Stripe, or Admin migrations during the run.

## Run reconciliation

```bash
node --experimental-strip-types scripts/fizot/j4-reconcile.mjs path/to/export.json
```

| Exit | Meaning |
| --- | --- |
| 0 | `PASS` (synthetic tool integrity only in current policy) |
| 1 | `FAIL` |
| 3 | `INSUFFICIENT_EVIDENCE` |
| 2 | usage / parse error |

Legacy totals-only: `scripts/fizot/ledger-reconcile.mjs` — not J4 acceptance.

## Investigate

1. **mismatched** — same request id but dimension failure; read `reasons`.
2. **Unmatched provider / ledger** — join gap or period skew; do not invent ids.
3. **Duplicates** — fix export; fail closed.
4. **Material per-request drift with clean aggregate** — investigate offsetting errors; do not waive on aggregate alone.
5. **Uncertain/quarantined** — leave held; settle/release only with explicit operator authorization and provider proof.

## Escalation

Preserve redacted export, CLI JSON, reconciler git SHA, operator identity/time. Unexplained billable drift → P0; block G4 / P4.3 close.

## Known limitations

- Internal models remain `mismatched_unverified` vs live xAI catalog.
- Cached / reasoning / tools / batch / priority / regional multipliers are variance sources.
- This tool cannot independently verify operator exports.
