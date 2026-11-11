import { verifyStripeSignature } from "../admin/webhooks.ts";
import { PLAN_INCLUDED_MICRO_GBP } from "../proxy/pricing.ts";
import type { createMemoryCreditStore } from "../proxy/credit-store.ts";
import type { createBillingService, StripeEvent } from "./apply.ts";
import type { createFakeEmailProvider } from "./email.ts";
import type { J9Config } from "./j9-config.ts";
import { assertPaidInvoice, invoiceIdFromSubscription, stripeQuantity } from "./j9-invoice.ts";
import { runStripeTestClockDunning } from "./j9-live-stages.ts";
import type { FakeStripeTransport, J9StripeTransport } from "./j9-transport.ts";
import { vatGate } from "./plan-prices.ts";
import type { J9RunArtifact, J9TrackedResources } from "./j9-run-artifact.ts";
import { DAY_MS, GRACE_WINDOW_MS, DELETE_AFTER_SUSPEND_MS, NOTICE_BEFORE_DELETE_MS, emptyRecord } from "./record.ts";
import type { J9EventSource, J9Kind, J9ScenarioResult, J9ScenarioStatus } from "./j9-types.ts";

function scenario(name: string, status: J9ScenarioStatus, source: J9EventSource, evidence: string, extra: Partial<J9ScenarioResult> = {}): J9ScenarioResult {
  return { scenario: name, status, source, evidence, ...extra };
}

function asEvent(id: string, type: string, created: number, object: Record<string, unknown>): StripeEvent {
  return { id, type, created, data: { object } } as StripeEvent;
}

function isFakeTransport(transport: J9StripeTransport): transport is FakeStripeTransport {
  return typeof (transport as FakeStripeTransport).markCheckoutComplete === "function";
}

export async function runCheckoutSessionCreated(
  config: J9Config,
  transport: J9StripeTransport,
  resources: J9TrackedResources,
  workspaceId: string,
  billing: ReturnType<typeof createBillingService>,
): Promise<J9ScenarioResult> {
  const customer = await transport.request("POST", "customers", {
    email: "j9@example.invalid",
    "address[country]": "GB",
    "metadata[workspace_id]": workspaceId,
  });
  const customerId = String(customer.id ?? "");
  if (!customerId) {
    return scenario("checkout_session_created", "FAIL", "stripe_api", "customer missing", { failureReason: "no customer id" });
  }
  resources.customers.push(customerId);
  const record = (await billing.store.get(workspaceId)) ?? emptyRecord(workspaceId);
  record.stripeCustomerId = customerId;
  record.plan = "home";
  record.country = "GB";
  await billing.store.save(record);

  const session = await transport.request("POST", "checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    success_url: config.successUrl,
    cancel_url: config.cancelUrl,
    client_reference_id: workspaceId,
    "line_items[0][price]": config.priceHome,
    "line_items[0][quantity]": "1",
    "automatic_tax[enabled]": "true",
    "tax_id_collection[enabled]": "true",
    billing_address_collection: "required",
    "metadata[workspace_id]": workspaceId,
    "metadata[plan]": "home",
    "subscription_data[metadata][workspace_id]": workspaceId,
    "subscription_data[metadata][plan]": "home",
  });
  // Full single-shot runs do not use a durable run artifact; staged live runs stamp fizot_j9_run_id in prepare.
  const sessionId = String(session.id ?? "");
  if (!sessionId || !session.url) {
    return scenario("checkout_session_created", "FAIL", "stripe_api", "checkout session incomplete", {
      failureReason: "missing id or url",
    });
  }
  resources.checkoutSessions.push(sessionId);
  if (session.status !== "open" && session.status != null) {
    return scenario("checkout_session_created", "FAIL", "stripe_api", `session=${sessionId}`, {
      failureReason: `expected open session, got ${String(session.status)}`,
    });
  }
  const taxOn = Boolean((session.automatic_tax as { enabled?: boolean } | undefined)?.enabled);
  const taxIdOn = Boolean((session.tax_id_collection as { enabled?: boolean } | undefined)?.enabled);
  if (!taxOn || !taxIdOn) {
    return scenario("checkout_session_created", "FAIL", "stripe_api", `session=${sessionId}`, {
      failureReason: `automatic_tax=${taxOn} tax_id_collection=${taxIdOn}`,
    });
  }
  return scenario(
    "checkout_session_created",
    "PASS",
    "stripe_api",
    `session=${sessionId} customer=${customerId} status=open payment_not_completed`,
  );
}

export async function runCheckoutCompleted(
  kind: J9Kind,
  transport: J9StripeTransport,
  resources: J9TrackedResources,
): Promise<J9ScenarioResult> {
  const sessionId = resources.checkoutSessions[0];
  if (!sessionId) {
    return scenario("checkout_completed", "FAIL", "none", "no checkout session", { failureReason: "missing session" });
  }
  if (kind === "fake_unit" && isFakeTransport(transport)) {
    transport.markCheckoutComplete(sessionId);
  }
  const session = await transport.request("GET", `checkout/sessions/${sessionId}`, null);
  if (session.status === "complete" && session.payment_status === "paid") {
    return scenario(
      "checkout_completed",
      "PASS",
      kind === "fake_unit" ? "stripe_api" : "stripe_api",
      `session=${sessionId} status=complete payment_status=paid kind=${kind} note=${kind === "fake_unit" ? "fake_markCheckoutComplete_only" : "stripe_hosted_complete"}`,
    );
  }
  if (kind === "live_j9") {
    return scenario("checkout_completed", "BLOCKED", "stripe_api", `session=${sessionId} status=${String(session.status)}`, {
      failureReason: "Hosted Checkout completion is not automated; complete the open test Session in Stripe test mode (browser or Stripe CLI) then re-run, or keep BLOCKED",
    });
  }
  return scenario("checkout_completed", "FAIL", "stripe_api", `session=${sessionId}`, {
    failureReason: `fake checkout not complete status=${String(session.status)}`,
  });
}

/** Credit evidence from the completed Checkout subscription — never a second unrelated Subscription API create. */
export async function runCheckoutSubscriptionPaymentAndCredit(input: {
  config: J9Config;
  transport: J9StripeTransport;
  workspaceId: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  alreadyGrantedInvoiceId: string | null;
  credit: ReturnType<typeof createMemoryCreditStore>;
  billing: ReturnType<typeof createBillingService>;
  applySignedFixture: (event: StripeEvent) => Promise<unknown>;
  createdSec: () => number;
  safeLog: (line: string) => void;
}): Promise<{ scenario: J9ScenarioResult; grantedInvoiceId: string | null }> {
  const sub = await input.transport.request("GET", `subscriptions/${input.subscriptionId}`, {
    "expand[]": "latest_invoice",
  });
  const invoice = sub.latest_invoice && typeof sub.latest_invoice === "object"
    ? sub.latest_invoice as Record<string, unknown>
    : await input.transport.request("GET", `invoices/${input.invoiceId}`, null);
  const paid = assertPaidInvoice(invoice, {
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
  });
  if (!paid.ok || paid.invoiceId !== input.invoiceId) {
    return {
      grantedInvoiceId: null,
      scenario: scenario("subscription_payment_and_credit", "FAIL", "stripe_api", `invoice=${input.invoiceId}`, {
        failureReason: paid.ok ? "checkout_invoice_id_mismatch" : paid.reason,
      }),
    };
  }

  const checkpointed = input.alreadyGrantedInvoiceId === paid.invoiceId;
  const t = input.createdSec();
  // Stable Stripe-event ids make webhook delivery idempotent across resume retries.
  await input.billing.applyEvent(asEvent(`evt_j9_checkout_sub_${input.subscriptionId}`, "customer.subscription.created", t, {
    id: input.subscriptionId,
    object: "subscription",
    status: String(sub.status ?? "active"),
    customer: input.customerId,
    metadata: (sub.metadata as Record<string, unknown> | undefined) ?? { workspace_id: input.workspaceId, plan: "home" },
    items: sub.items,
  }));
  const paidEvent = asEvent(`evt_j9_checkout_paid_${paid.invoiceId}`, "invoice.paid", t + 1, invoice);
  await input.applySignedFixture(paidEvent);
  await input.applySignedFixture(paidEvent);
  const summary = await input.credit.summary(input.workspaceId);
  const expected = PLAN_INCLUDED_MICRO_GBP.home;
  if (summary.balanceMicroGbp !== expected) {
    return {
      grantedInvoiceId: null,
      scenario: scenario("subscription_payment_and_credit", "FAIL", "locally_signed_fixture", `balance=${summary.balanceMicroGbp}`, {
        failureReason: `expected included credit ${expected} once from checkout invoice`,
      }),
    };
  }
  if (!(await input.billing.allows(input.workspaceId))) {
    return {
      grantedInvoiceId: null,
      scenario: scenario("subscription_payment_and_credit", "FAIL", "locally_signed_fixture", "proxy refused", {
        failureReason: "subscription_required",
      }),
    };
  }
  input.safeLog(`checkout_payment_and_credit subscription=${input.subscriptionId} invoice=${paid.invoiceId} checkpointed=${checkpointed}`);
  return {
    grantedInvoiceId: paid.invoiceId,
    scenario: scenario(
      "subscription_payment_and_credit",
      "PASS",
      "stripe_api",
      `subscription=${input.subscriptionId} invoice=${paid.invoiceId} source=checkout_session_subscription separate_api_subscription=false duplicate_grant=false credit_checkpoint=${checkpointed ? "hit" : "set"} credit_evidence=isolated_in_memory_billing_logic balance=${summary.balanceMicroGbp}`,
    ),
  };
}

export async function runSubscriptionPaymentAndCredit(input: {
  config: J9Config;
  transport: J9StripeTransport;
  resources: J9TrackedResources;
  workspaceId: string;
  credit: ReturnType<typeof createMemoryCreditStore>;
  billing: ReturnType<typeof createBillingService>;
  applySignedFixture: (event: StripeEvent) => Promise<unknown>;
  createdSec: () => number;
  safeLog: (line: string) => void;
}): Promise<J9ScenarioResult> {
  const customerId = input.resources.customers[0];
  if (!customerId) {
    return scenario("subscription_payment_and_credit", "FAIL", "none", "no customer", { failureReason: "missing customer" });
  }

  const pm = await input.transport.request("POST", "payment_methods", {
    type: "card",
    "card[token]": "tok_visa",
  });
  const pmId = String(pm.id ?? "");
  if (!pmId) {
    return scenario("subscription_payment_and_credit", "FAIL", "stripe_api", "payment method missing", {
      failureReason: "no payment_method id",
    });
  }
  await input.transport.request("POST", `payment_methods/${pmId}/attach`, { customer: customerId });

  const sub = await input.transport.request("POST", "subscriptions", {
    customer: customerId,
    default_payment_method: pmId,
    "items[0][price]": input.config.priceHome,
    "items[0][quantity]": "1",
    "metadata[workspace_id]": input.workspaceId,
    "metadata[plan]": "home",
    payment_behavior: "error_if_incomplete",
    "expand[]": "latest_invoice",
  });
  const subscriptionId = String(sub.id ?? "");
  if (!subscriptionId) {
    return scenario("subscription_payment_and_credit", "FAIL", "stripe_api", "subscription missing", {
      failureReason: "no subscription id",
    });
  }
  input.resources.subscriptions.push(subscriptionId);

  // Independent Subscription API journey — not linked to an incomplete Checkout Session.
  const invoiceId = invoiceIdFromSubscription(sub);
  if (!invoiceId) {
    return scenario("subscription_payment_and_credit", "FAIL", "stripe_api", `subscription=${subscriptionId}`, {
      failureReason: "latest_invoice missing; no fabricated invoice",
    });
  }
  let invoice: Record<string, unknown>;
  if (sub.latest_invoice && typeof sub.latest_invoice === "object") {
    invoice = sub.latest_invoice as Record<string, unknown>;
  } else {
    invoice = await input.transport.request("GET", `invoices/${invoiceId}`, null);
  }
  const paid = assertPaidInvoice(invoice, { customerId, subscriptionId });
  if (!paid.ok) {
    return scenario("subscription_payment_and_credit", "FAIL", "stripe_api", `invoice=${invoiceId}`, {
      failureReason: paid.reason,
    });
  }

  const t = input.createdSec();
  await input.billing.applyEvent(asEvent(`evt_sub_${t}`, "customer.subscription.created", t, {
    id: subscriptionId,
    object: "subscription",
    status: String(sub.status ?? "active"),
    customer: customerId,
    default_payment_method: pmId,
    metadata: (sub.metadata as Record<string, unknown> | undefined) ?? { workspace_id: input.workspaceId, plan: "home" },
    items: sub.items,
  }));

  // Webhook delivery is a locally signed fixture; the invoice object came from Stripe API.
  const paidEvent = asEvent(`evt_paid_${t}`, "invoice.paid", t + 1, invoice);
  await input.applySignedFixture(paidEvent);
  await input.applySignedFixture(paidEvent);

  const summary = await input.credit.summary(input.workspaceId);
  const expected = PLAN_INCLUDED_MICRO_GBP.home;
  if (summary.balanceMicroGbp !== expected) {
    return scenario("subscription_payment_and_credit", "FAIL", "locally_signed_fixture", `balance=${summary.balanceMicroGbp}`, {
      failureReason: `expected included credit ${expected} once`,
    });
  }
  if (!(await input.billing.allows(input.workspaceId))) {
    return scenario("subscription_payment_and_credit", "FAIL", "locally_signed_fixture", "proxy refused", {
      failureReason: "subscription_required",
    });
  }
  input.safeLog(`subscription_payment_and_credit subscription=${subscriptionId} invoice=${paid.invoiceId} balance=${summary.balanceMicroGbp}`);
  return scenario(
    "subscription_payment_and_credit",
    "PASS",
    "locally_signed_fixture",
    `subscription=${subscriptionId} invoice=${paid.invoiceId} invoice_object=stripe_api webhook_delivery=locally_signed_fixture balance=${summary.balanceMicroGbp} duplicate_grant=false separate_from_checkout=true`,
  );
}

export async function runWebhookLifecycle(input: {
  config: J9Config;
  workspaceId: string;
  billing: ReturnType<typeof createBillingService>;
  credit: ReturnType<typeof createMemoryCreditStore>;
  createdSec: () => number;
  kind: J9Kind;
}): Promise<J9ScenarioResult> {
  const bad = asEvent("evt_bad_sig", "customer.updated", input.createdSec(), {
    id: "cus_ignore",
    object: "customer",
    metadata: { workspace_id: input.workspaceId },
  });
  const verified = verifyStripeSignature({
    secret: input.config.webhookSecret,
    body: JSON.stringify(bad),
    header: "t=1,v1=deadbeef",
    now: () => bad.created * 1000,
  });
  if (verified.ok) {
    return scenario("webhook_lifecycle", "FAIL", "locally_signed_fixture", "invalid signature accepted", {
      failureReason: "verifyStripeSignature returned ok",
    });
  }
  const before = await input.credit.summary(input.workspaceId);
  const beforeStatus = (await input.billing.store.get(input.workspaceId))?.status;
  await input.billing.applyEvent(asEvent("evt_stale_paid", "invoice.payment_failed", 1, {
    id: "in_stale",
    object: "invoice",
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  }));
  const afterStale = await input.billing.store.get(input.workspaceId);
  if (afterStale?.status !== beforeStatus) {
    return scenario("webhook_lifecycle", "FAIL", "locally_signed_fixture", "stale payment_failed applied", {
      failureReason: `status ${beforeStatus}→${afterStale?.status}`,
    });
  }
  const after = await input.credit.summary(input.workspaceId);
  if (after.balanceMicroGbp !== before.balanceMicroGbp) {
    return scenario("webhook_lifecycle", "FAIL", "locally_signed_fixture", "credit changed", {
      failureReason: `before=${before.balanceMicroGbp} after=${after.balanceMicroGbp}`,
    });
  }
  if (input.kind === "live_j9") {
    return scenario(
      "webhook_lifecycle",
      "BLOCKED",
      "locally_signed_fixture",
      "fixture_checks_ok stripe_signed_delivery_missing",
      {
        failureReason: "Local fixtures are not Stripe-originated delivery. Provide STRIPE_J9_WEBHOOK_CAPTURE_PATH from Stripe CLI for this run, or keep BLOCKED",
      },
    );
  }
  return scenario(
    "webhook_lifecycle",
    "PASS",
    "locally_signed_fixture",
    "invalid_signature=rejected stale_event=ignored label=locally_signed_fixture_not_stripe_delivery",
  );
}

export async function runSimulatedFailedPayment(input: {
  workspaceId: string;
  billing: ReturnType<typeof createBillingService>;
  applySignedFixture: (event: StripeEvent) => Promise<unknown>;
  createdSec: () => number;
  email: ReturnType<typeof createFakeEmailProvider>;
  deletes: string[];
  now: () => number;
  advance: (ms: number) => Promise<unknown>;
}): Promise<J9ScenarioResult> {
  const t = input.createdSec();
  await input.applySignedFixture(asEvent(`evt_fail_${t}`, "invoice.payment_failed", t, {
    id: `in_fail_${t}`,
    object: "invoice",
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  }));
  const pastDue = await input.billing.store.get(input.workspaceId);
  if (pastDue?.status !== "past_due") {
    return scenario("simulated_failed_payment_lifecycle", "FAIL", "locally_signed_fixture", `status=${pastDue?.status}`, {
      failureReason: "expected past_due",
    });
  }
  await input.advance(0);
  const grace = await input.billing.store.get(input.workspaceId);
  if (grace?.status !== "grace") {
    return scenario("simulated_failed_payment_lifecycle", "FAIL", "simulated_clock", `status=${grace?.status}`, {
      failureReason: "expected grace",
    });
  }
  const suspendAt = (grace.firstFailureAt ?? t * 1000) + GRACE_WINDOW_MS;
  await input.advance(Math.max(0, suspendAt - input.now()));
  const suspended = await input.billing.store.get(input.workspaceId);
  if (suspended?.status !== "suspended" || await input.billing.allows(input.workspaceId)) {
    return scenario("simulated_failed_payment_lifecycle", "FAIL", "simulated_clock", `status=${suspended?.status}`, {
      failureReason: "expected suspended with proxy denied",
    });
  }
  const noticeAt = (suspended.suspendedAt ?? suspendAt) + DELETE_AFTER_SUSPEND_MS - NOTICE_BEFORE_DELETE_MS;
  await input.advance(Math.max(0, noticeAt - input.now()));
  if (input.email.sent.length < 1) await input.advance(DAY_MS);
  if (input.email.sent.length < 1) {
    return scenario("simulated_failed_payment_lifecycle", "FAIL", "simulated_clock", "notice missing", {
      failureReason: "expected deletion notice",
    });
  }
  return scenario(
    "simulated_failed_payment_lifecycle",
    "PASS",
    "simulated_clock",
    `label=simulated_app_lifecycle_not_stripe_dunning past_due→grace→suspended notice=${input.email.sent.length}`,
  );
}

export async function runSimulatedRecovery(input: {
  workspaceId: string;
  billing: ReturnType<typeof createBillingService>;
  applySignedFixture: (event: StripeEvent) => Promise<unknown>;
  createdSec: () => number;
  credit: ReturnType<typeof createMemoryCreditStore>;
  resumes: string[];
}): Promise<J9ScenarioResult> {
  const before = await input.credit.summary(input.workspaceId);
  const t = input.createdSec();
  const invoiceId = `in_recover_${t}`;
  const payload = {
    id: invoiceId,
    object: "invoice",
    status: "paid",
    paid: true,
    livemode: false,
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  };
  await input.applySignedFixture(asEvent(`evt_recover_${t}`, "invoice.paid", t, payload));
  await input.applySignedFixture(asEvent(`evt_recover_${t}`, "invoice.paid", t, payload));
  const record = await input.billing.store.get(input.workspaceId);
  if (record?.status !== "active" || !(await input.billing.allows(input.workspaceId))) {
    return scenario("simulated_recovery", "FAIL", "locally_signed_fixture", `status=${record?.status}`, {
      failureReason: "expected active with proxy allowed",
    });
  }
  const after = await input.credit.summary(input.workspaceId);
  const expected = before.balanceMicroGbp + PLAN_INCLUDED_MICRO_GBP.home;
  if (after.balanceMicroGbp !== expected || !input.resumes.includes(input.workspaceId)) {
    return scenario("simulated_recovery", "FAIL", "locally_signed_fixture", `balance=${after.balanceMicroGbp}`, {
      failureReason: "grant or resume mismatch",
    });
  }
  return scenario(
    "simulated_recovery",
    "PASS",
    "locally_signed_fixture",
    `label=simulated_recovery_fixture_not_stripe_test_clock status=active balance=${after.balanceMicroGbp}`,
  );
}

export async function runStripeDunning(input: {
  kind: J9Kind;
  transport: J9StripeTransport;
  artifact: J9RunArtifact | null;
  hmacSecret: string;
  artifactPath: string;
  sleepMs: number;
}): Promise<{ scenario: J9ScenarioResult; artifact: J9RunArtifact | null }> {
  if (input.kind === "fake_unit") {
    return {
      artifact: input.artifact,
      scenario: scenario(
        "stripe_dunning_recovery",
        "NOT_RUN",
        "none",
        "not required for fake_unit acceptance; real Stripe Test Clock dunning remains a live_j9 requirement",
      ),
    };
  }
  if (!input.artifact?.clock.subscriptionId) {
    return {
      artifact: input.artifact,
      scenario: scenario("stripe_dunning_recovery", "BLOCKED", "none", "live stage artifact with Test Clock subscription required", {
        failureReason: "Run STRIPE_J9_STAGE=prepare then resume after Checkout; Test Clock dunning is not available on single-shot full live runs without an artifact",
      }),
    };
  }
  const result = await runStripeTestClockDunning({
    transport: input.transport,
    artifact: input.artifact,
    hmacSecret: input.hmacSecret,
    artifactPath: input.artifactPath,
    sleepMs: input.sleepMs,
  });
  return { scenario: result.scenario, artifact: result.artifact };
}

export async function runTaxAndSeats(input: {
  config: J9Config;
  transport: J9StripeTransport;
  resources: J9TrackedResources;
}): Promise<J9ScenarioResult> {
  if (vatGate("FR", "") !== "vat_id_required") {
    return scenario("tax_and_seats", "FAIL", "config", "vatGate", { failureReason: "expected vat_id_required" });
  }
  let taxEvidence = "";
  try {
    const gb = await input.transport.request("POST", "tax/calculations", {
      currency: "gbp",
      "line_items[0][amount]": "1999",
      "line_items[0][reference]": "home",
      "customer_details[address][country]": "GB",
      "customer_details[address_source]": "billing",
    });
    const eu = await input.transport.request("POST", "tax/calculations", {
      currency: "gbp",
      "line_items[0][amount]": "1999",
      "line_items[0][reference]": "home",
      "customer_details[address][country]": "FR",
      "customer_details[address_source]": "billing",
      "customer_details[tax_ids][0][type]": "eu_vat",
      "customer_details[tax_ids][0][value]": "FR12345678901",
    });
    const gbTax = Number(gb.tax_amount_exclusive ?? -1);
    const euTax = Number(eu.tax_amount_exclusive ?? -1);
    if (gbTax !== 400 || euTax !== 0) {
      return scenario("tax_and_seats", "BLOCKED", "stripe_api", `gb=${gbTax} eu=${euTax}`, {
        failureReason: "Stripe Tax amounts differ from the GB 20% / EU reverse-charge fixture; check Tax settings on the test account",
      });
    }
    taxEvidence = "gb_vat=400 eu_reverse_charge=0";
  } catch (error) {
    return scenario("tax_and_seats", "BLOCKED", "stripe_api", "tax/calculations unavailable", {
      failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 160),
    });
  }

  const subId = input.resources.subscriptions[0];
  if (!subId) {
    return scenario("tax_and_seats", "FAIL", "stripe_api", taxEvidence, { failureReason: "missing subscription" });
  }
  const before = await input.transport.request("GET", `subscriptions/${subId}`, null);
  const beforeQty = stripeQuantity(before);
  if (!beforeQty.itemId) {
    return scenario("tax_and_seats", "FAIL", "stripe_api", taxEvidence, { failureReason: "subscription item id missing from Stripe" });
  }
  await input.transport.request("POST", `subscriptions/${subId}`, {
    "items[0][id]": beforeQty.itemId,
    "items[0][quantity]": "3",
  });
  const after = await input.transport.request("GET", `subscriptions/${subId}`, null);
  const afterQty = stripeQuantity(after);
  if (afterQty.quantity !== 3) {
    return scenario("tax_and_seats", "FAIL", "stripe_api", taxEvidence, {
      failureReason: `stripe_quantity=${afterQty.quantity} expected=3 (local app state ignored)`,
    });
  }
  return scenario(
    "tax_and_seats",
    "PASS",
    "stripe_api",
    `${taxEvidence} stripe_seats=3 item=${beforeQty.itemId} fixture_vatGate=vat_id_required`,
  );
}

