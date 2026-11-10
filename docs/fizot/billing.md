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

Required configuration:

| Name | Kind | Rule |
| --- | --- | --- |
| `STRIPE_J9_MODE` | env | Must be exactly `test` |
| `STRIPE_TEST_API_KEY` | secret | Must start with `sk_test_`; live keys are rejected |
| `STRIPE_TEST_WEBHOOK_SECRET` | secret | Stripe webhook signing secret (`whsec_…`) |
| `STRIPE_J9_PRICE_HOME` | variable | Real Stripe **test** Price id; not `price_unpublished_*` |
| `STRIPE_J9_PRICE_TEAM` | variable | Optional; defaults to the home test Price |
| `STRIPE_J9_TRANSPORT` | env | `live` (default in Actions) or `fake` (unit tests only) |

Mandatory scenarios: `secure_startup`, `checkout`, `payment_and_credit`, `webhook_lifecycle`, `failed_payment_lifecycle`, `recovery`, `tax_and_seats`, `cleanup`. Any `FAIL`, `BLOCKED` or `NOT_RUN` prevents overall PASS.

Webhook deliveries into the billing state machine are locally signed with the test webhook secret (fixture). Stripe API objects (customer, checkout session, subscription, tax calculation, cleanup) are real when `STRIPE_J9_TRANSPORT=live`. Grace, suspension and notice use the app's simulated clock, not a production clock.

Create a recurring test Price in the Stripe Dashboard (GBP, tax behavior exclusive) and set `STRIPE_J9_PRICE_HOME` to that id before dispatching the workflow.
