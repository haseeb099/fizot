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

1. **Stage A — prepare** (`STRIPE_J9_STAGE=prepare`): creates an isolated Test Clock, a clock-attached baseline subscription (paid invoice), a separate Checkout customer + open Session, and writes a **non-secret** run artifact to `STRIPE_J9_ARTIFACT_PATH`. Cleanup is **paused** (`cleanup=retained`). Overall is BLOCKED awaiting Checkout.
2. Operator opens the printed Checkout URL, pays with a Stripe **test** card, and (optionally) captures signed webhook deliveries with Stripe CLI to a local JSON file (no public endpoint required).
3. **Stage B — resume** (`STRIPE_J9_STAGE=resume`): loads the same artifact, verifies ownership MAC + Stripe metadata `fizot_j9_run_id`, requires Session `status=complete` + `payment_status=paid` + matching customer/subscription/price/`livemode=false`, then continues credit, simulated app lifecycle, Test Clock failure/recovery correlation, tax/seats, and cleanup.
4. **Abandoned cleanup** (`STRIPE_J9_STAGE=cleanup` + `STRIPE_J9_CLEANUP_CONFIRM=<runId>`): deletes only resources listed in that sealed artifact.

Required configuration:

| Name | Kind | Rule |
| --- | --- | --- |
| `STRIPE_J9_MODE` | env | Must be exactly `test` |
| `STRIPE_TEST_API_KEY` | secret | Must start with `sk_test_`; live keys are rejected |
| `STRIPE_TEST_WEBHOOK_SECRET` | secret | Stripe webhook signing secret (`whsec_…`) |
| `STRIPE_J9_PRICE_HOME` | variable | Real Stripe **test** recurring Price id; not `price_unpublished_*` |
| `STRIPE_J9_PRICE_TEAM` | variable | Optional; defaults to the home test Price |
| `STRIPE_J9_TRANSPORT` | env | Actions must use `live`. `fake` is unit tests only |
| `STRIPE_J9_STAGE` | env | `full` \| `prepare` \| `resume` \| `cleanup` |
| `STRIPE_J9_ARTIFACT_PATH` | path | Required for prepare/resume/cleanup. JSON; no secrets |
| `STRIPE_J9_WEBHOOK_CAPTURE_PATH` | path | Required for live webhook PASS: Stripe CLI signed capture for this `runId` |
| `STRIPE_J9_CLEANUP_CONFIRM` | env | Must equal artifact `runId` for abandoned cleanup |

Shared scenarios: `secure_startup`, `checkout_session_created`, `checkout_completed`, `subscription_payment_and_credit`, `webhook_lifecycle`, `simulated_failed_payment_lifecycle`, `simulated_recovery`, `tax_and_seats`, `cleanup`. Live also requires `stripe_dunning_recovery`. Any required `FAIL`, `BLOCKED` or `NOT_RUN` prevents overall PASS and sets `live_acceptance=false`.

### Evidence rules

- `checkout_session_created` only proves Session creation. `checkout_completed` requires Stripe `status=complete` and `payment_status=paid` for the **same** artifact Session. Incomplete Checkout stays BLOCKED. Never fabricate paid Checkout evidence.
- Paid invoices require `object=invoice`, `in_…`, `livemode===false`, `paid===true`, `status=paid`, matching `cus_` / `sub_`. No fabricated invoices.
- Seat quantity is re-read from Stripe subscription items only.
- Simulated grace/suspension/recovery uses the **Fizot app worker clock** and remains labelled simulated. Stripe Test Clock `frozen_time` is separate evidence for `stripe_dunning_recovery`.
- Locally signed webhook fixtures prove signature/idempotency unit behaviour. They do **not** satisfy live webhook delivery. Live PASS needs a Stripe CLI signed capture file verified against `STRIPE_TEST_WEBHOOK_SECRET` for the same `runId`. Do not expose production webhook endpoints or invent public test endpoints without explicit approval.
- Test Clock: create clock → attach new customer (`test_clock=`) → baseline paid subscription → attach `pm_card_chargeCustomerFail` → advance → poll until `status=ready` → correlate Stripe `invoice.payment_failed` → restore `pm_card_visa` → advance → correlate `invoice.paid`. `internal_failure`, unsupported intervals, or missing Stripe-generated events stay BLOCKED.
- Cleanup expires open Sessions, then deletes subscriptions, customers and test clocks tracked by the artifact. Foreign resource ids are refused. Partial cleanup never reports `cleanup=complete`. Paused prepare runs must use the confirmed cleanup stage.

### Costs and limits

Stripe Test Clocks auto-delete after a short retention window (`deletes_after`). Prepare then resume without long delays. Test-mode API usage is low cost but not free of Stripe rate limits (HTTP 429 fails cleanup/verification). Plan prices stay unpublished until margin evidence exists.

Create a recurring test Price in the Stripe Dashboard (GBP, tax behavior exclusive) and set `STRIPE_J9_PRICE_HOME` before a live dispatch. Do not mark BL-E / FZ-27 / G4 Done from a fake_unit PASS or from prepare-only BLOCKED output.
