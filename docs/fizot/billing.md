# Billing (P4.4)

B2B only. Consumer cooling-off, EU withdrawal, Lite, trials-as-a-journey and the free tier are deferred.

## Included credit

Creating a workspace grants nothing. The proxy returns `402 {error:"subscription_required"}` until the workspace has an active subscription, or a trialing subscription with a payment method. `invoice.paid` grants that period's included credit once. The ledger `request_id` is the Stripe invoice id.

`past_due` and `grace` still serve the proxy. `suspended` sleeps the machine when it has one, blocks the proxy, and keeps the data.

## Lifecycle

Stored timestamps, advanced by the deletion worker tick:

| From | When | To |
| --- | --- | --- |
| payment failed | immediately | `past_due` |
| `past_due` | next tick, before 7 days | `grace` |
| `grace` | 7 days after the first failure | `suspended` |
| `suspended` | 23 days later (7 days before deletion) | email notice |
| `suspended` | 30 days after suspension | P4.2 deletion job |
| any state before deletion | payment recovered | `active`, machine resumed |

## Checkout and portal

`POST /admin/workspaces/:id/billing/checkout` and `POST .../billing/portal` are owner-only. Success, cancel and portal return URLs come from `FIZOT_BILLING_SUCCESS_URL`, `FIZOT_BILLING_CANCEL_URL` and `FIZOT_BILLING_PORTAL_RETURN_URL`. The request body cannot set them.

Outside the UK a business VAT ID is required. Stripe Tax calculates UK 20% VAT. A non-UK VAT ID is reverse charge. This server does not calculate tax.

Team quantity is the membership count. The owner is a seat. Invite accept and member removal sync the Stripe subscription quantity.

## Prices

`server/fizot/billing/plan-prices.ts` holds the amounts. Both plans are `unpublished` and `unverified`. Checkout returns `403 plan_unpublished` unless `NODE_ENV=test` or `FIZOT_BILLING_MODE=test`.

`node --experimental-strip-types scripts/fizot/margin-check.mjs` reads `docs/fizot/cost-sheet.md`, the tier markup and this config. It exits 1 when a published plan is below 40% gross margin at always-on with the included credit fully used.

## Webhooks

`POST /admin/webhooks/stripe` keeps the P4.2 `t=,v1=` check and event-id dedupe. Handled types: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalized`, `customer.updated`. An event older than the stored `created` time does not move the subscription backwards.

## J9

`.github/workflows/billing-stripe-j9.yml` is manual. The driver is `scripts/fizot/billing-j9.mjs` (`server/fizot/billing/j9-driver.ts`). Credentials alone never exit 0.

Acceptance kinds:

| Kind | When | Meaning of PASS |
| --- | --- | --- |
| `fake_unit` | `STRIPE_J9_TRANSPORT=fake` | Deterministic unit journey only. `live_acceptance=false`. |
| `live_j9` | `STRIPE_J9_TRANSPORT=live` | Complete Stripe test-mode E2E. Requires hosted Checkout completion, Stripe Test Clock dunning, and Stripe-signed webhook capture. |

### Live two-stage operator journey

Hosted Checkout completion is **manual**. Stripe’s supported testing path is a browser/Dashboard Checkout with test cards; fragile browser automation is not used.

Artifact paths are **fixed**: `artifacts/j9/run.json` and `artifacts/j9/webhook-capture.json`. Workflow inputs are never shell paths. Integrity uses `STRIPE_J9_ARTIFACT_HMAC_SECRET` (never written into the artifact). Schema v4 binds runId, stage, transitions, workspace, prices, resource ids, retrySafe, Checkout `creditInvoiceId`, Test Clock `dunning` checkpoints and expiry into the MAC. Stripe credentials, webhook secrets and test-card details must never appear in artifacts.

**Test Clock resume checkpoints**

Dunning persists authenticated phases (`baseline` → `fail_pm_set` → `failure_advance_committed` → `failure_advanced` → `failure_confirmed` → `recover_pm_set` → `recovery_advance_committed` → `recovery_advanced` → `recovered`) with fail/recover targets and distinct failure/recovery invoice ids. A fresh `advance` POST is issued only in the same turn that records `*_advance_committed`. On resume of an already-committed checkpoint the driver never POSTs again: at/past target or `advancing` → poll only; `ready` but below target → `BLOCKED` (`advance_outcome_ambiguous`) and retain resources for operator-reviewed recovery. Baseline invoices/events never count as recovery. Checkout credit checkpoint evidence in the harness is **isolated in-memory billing-logic** only; durable credit-ledger exactly-once across Actions runs remains a separate P4.3/J4 acceptance requirement.

**Lifecycle stages (authenticated transitions)**

| Stage | Meaning |
| --- | --- |
| `awaiting_checkout` | Prepare wrote open Session; resources retained |
| `awaiting_evidence` | Checkout complete; webhook/dunning/other evidence still incomplete; retryable |
| `retryable_failure` | Verification FAIL but resources retained for retry |
| `cleanup_partial` | Cleanup attempted; some resources remain; not abandoned |
| `completed` | Full verification PASS and auto-cleanup succeeded |
| `abandoned` | Confirmed cleanup emptied tracked resources |

Incomplete resume **never** auto-deletes. Auto-cleanup runs only after every mandatory scenario (except cleanup) is PASS. Confirmed `stage=cleanup` is separate.

**Actions resume of the same run**

1. Dispatch `billing-stripe-j9.yml` with `stage=prepare`. Note `github.run_id` and printed `runId` (`j9run_…`).
2. Open Checkout URL; pay with a Stripe **test** card.
3. Capture signed Stripe CLI deliveries (unmodified body + full `Stripe-Signature` header). Pack with `scripts/fizot/j9-pack-webhook-capture.mjs` into fixed `artifacts/j9/webhook-capture.json`. Put **only** that file on a throwaway branch; dispatch `stage=upload_capture` on that ref; note the Actions run id as `capture_run_id`; delete the branch. Artifact retention is 7 days. Never include API keys, `whsec_…`, or card data.
4. First resume: `artifact_run_id=<prepare github.run_id>` (+ `capture_run_id`). Downloads latest artifact into fixed paths; verifies MAC.
5. If resume is BLOCKED/FAIL, the resume run uploads the **updated** artifact. Next resume/cleanup must use `artifact_run_id=<that resume run id>` — never re-use a stale prepare artifact after lifecycle advanced.
6. Confirmed cleanup (including MAC-valid expired artifacts): `stage=cleanup`, `artifact_run_id=<latest upload run>`, `cleanup_confirm=<runId>`.

**Local stages**

1. **prepare**: Test Clock + baseline subscription + Checkout Session. Stage `awaiting_checkout`. Mid-prepare failures → `cleanup_partial`.
2. Operator completes Checkout; optional capture file.
3. **resume**: no duplicate customers/clocks/subs; credits Checkout subscription only; persists latest stage before exit; retains on incomplete evidence.
4. **cleanup** + confirm: pre-verifies live ownership for every id, then deletes. Unprovable ownership is refused and reported.

Required configuration:

| Name | Kind | Rule |
| --- | --- | --- |
| `STRIPE_J9_MODE` | env | Must be exactly `test` |
| `STRIPE_TEST_API_KEY` | secret | Must start with `sk_test_`; live keys are rejected |
| `STRIPE_TEST_WEBHOOK_SECRET` | secret | Stripe webhook signing secret (`whsec_…`) |
| `STRIPE_J9_ARTIFACT_HMAC_SECRET` | secret | ≥32 chars; independent of Stripe; never stored in artifacts |
| `STRIPE_J9_PRICE_HOME` | variable | Real Stripe **test** recurring Price id; not `price_unpublished_*` |
| `STRIPE_J9_PRICE_TEAM` | variable | Optional; defaults to the home test Price |
| `STRIPE_J9_TRANSPORT` | env | Actions must use `live`. `fake` is unit tests only |
| `STRIPE_J9_STAGE` | env | `full` \| `prepare` \| `resume` \| `cleanup` |
| `STRIPE_J9_ARTIFACT_RUN_ID` | env | Digits-only GitHub Actions run id that uploaded the **latest** `j9-run-artifact` |
| `STRIPE_J9_PREPARE_RUN_ID` | env | Deprecated alias for `STRIPE_J9_ARTIFACT_RUN_ID` |
| `STRIPE_J9_CLEANUP_CONFIRM` | env | Must equal artifact `runId` for abandoned/expired confirmed cleanup |

Shared scenarios: `secure_startup`, `checkout_session_created`, `checkout_completed`, `subscription_payment_and_credit`, `webhook_lifecycle`, `simulated_failed_payment_lifecycle`, `simulated_recovery`, `tax_and_seats`, `cleanup`. Live also requires `stripe_dunning_recovery`. Any required `FAIL`, `BLOCKED` or `NOT_RUN` prevents overall PASS and sets `live_acceptance=false`. Fake-unit PASS never becomes live acceptance.

### Evidence rules

- `checkout_session_created` only proves Session creation. `checkout_completed` requires Stripe `status=complete` and `payment_status=paid` for the **same** artifact Session/subscription. A second paid subscription must not satisfy Checkout. Incomplete Checkout stays BLOCKED. Never fabricate paid Checkout evidence.
- Paid invoices require `object=invoice`, `in_…`, `livemode===false`, `paid===true`, `status=paid`, matching `cus_` / `sub_`. No fabricated invoices.
- Seat quantity is re-read from Stripe subscription items only.
- Simulated grace/suspension/recovery uses the **Fizot app worker clock** and remains labelled simulated. Stripe Test Clock `frozen_time` is separate evidence for `stripe_dunning_recovery`.
- Webhook capture schema v2: `provenance` is an operator claim only. Verify Stripe-Signature using header `t=` (never body `created`). Session events require `fizot_j9_run_id` on the Checkout Session. `invoice.paid` ownership is proven via Stripe-retrieved Invoice → Subscription (legacy `subscription` or `parent.subscription_details.subscription`) plus the artifact Session; invoice metadata is not required. Correlate `checkout.session.completed` + `invoice.paid` to the same Checkout journey. Retrieve each `evt_…` from the Stripe Events API (`livemode=false`). Signature PASS without origin stays BLOCKED for live acceptance.
- Test Clock: frozen time starts near now (not a fixed calendar date). Record baseline invoice + event ids → set **subscription** `default_payment_method` to `pm_card_chargeCustomerFail` (subscription PM precedes customer `invoice_settings`) → advance within Stripe’s ≤2-period window → poll until `status=ready` → correlate post-baseline `invoice.payment_failed` → restore subscription PM to `pm_card_visa` → advance → require a distinct recovery invoice/`invoice.paid` (baseline excluded). Missing associations or event evidence stay BLOCKED.
- Cleanup expires open Sessions, then deletes subscriptions, customers and test clocks tracked by the artifact after live ownership checks. Foreign resource ids are refused. Partial cleanup never reports `cleanup=complete` and does not mark `abandoned` while resources may remain. Paused prepare / mid-prepare `cleanup_partial` runs must use the confirmed cleanup stage.

### Costs and limits

Stripe Test Clocks auto-delete after a short retention window (`deletes_after`). Prepare then resume without long delays. Test-mode API usage is low cost but not free of Stripe rate limits (HTTP 429 fails cleanup/verification). Plan prices stay unpublished until margin evidence exists.

Create a recurring test Price in the Stripe Dashboard (GBP, tax behavior exclusive) and set `STRIPE_J9_PRICE_HOME` before a live dispatch. Do not mark BL-E / FZ-27 / G4 Done from a fake_unit PASS or from prepare-only BLOCKED output.
