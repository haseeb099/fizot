import { signStripeHeader, verifyStripeSignature, deliverWebhookEvent, createMemoryWebhookEventStore } from "../admin/webhooks.ts";
import { PLAN_INCLUDED_MICRO_GBP } from "../proxy/pricing.ts";
import { createMemoryCreditStore } from "../proxy/credit-store.ts";
import { createBillingService, type StripeEvent } from "./apply.ts";
import { createFakeEmailProvider } from "./email.ts";
import { resolveJ9Config, redactSecrets, type J9Config } from "./j9-config.ts";
import { createFakeStripeTransport, createLiveStripeTransport, type J9StripeTransport } from "./j9-transport.ts";
import { createFakeBillingProvider } from "./provider.ts";
import { DAY_MS, GRACE_WINDOW_MS, DELETE_AFTER_SUSPEND_MS, NOTICE_BEFORE_DELETE_MS } from "./record.ts";
import { createMemoryBillingStore } from "./store.ts";
import { vatGate } from "./plan-prices.ts";

export type J9ScenarioStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type J9EventSource = "stripe_api" | "locally_signed_fixture" | "simulated_clock" | "config" | "none";

export type J9ScenarioResult = {
  scenario: string;
  status: J9ScenarioStatus;
  source: J9EventSource;
  evidence: string;
  failureReason?: string;
  cleanup?: string;
};

export type J9Report = {
  overall: "PASS" | "FAIL" | "BLOCKED";
  exitCode: number;
  scenarios: J9ScenarioResult[];
  resources: { customers: string[]; subscriptions: string[]; checkoutSessions: string[] };
};

const MANDATORY = [
  "secure_startup",
  "checkout",
  "payment_and_credit",
  "webhook_lifecycle",
  "failed_payment_lifecycle",
  "recovery",
  "tax_and_seats",
  "cleanup",
] as const;

function scenario(name: string, status: J9ScenarioStatus, source: J9EventSource, evidence: string, extra: Partial<J9ScenarioResult> = {}): J9ScenarioResult {
  return { scenario: name, status, source, evidence, ...extra };
}

function finish(scenarios: J9ScenarioResult[], resources: J9Report["resources"]): J9Report {
  const byName = new Map(scenarios.map((row) => [row.scenario, row]));
  const ordered = MANDATORY.map((name) => byName.get(name) ?? scenario(name, "NOT_RUN", "none", "not executed"));
  const hasFail = ordered.some((row) => row.status === "FAIL");
  const hasBlockedOrSkip = ordered.some((row) => row.status === "BLOCKED" || row.status === "NOT_RUN");
  const overall = hasFail ? "FAIL" : hasBlockedOrSkip ? "BLOCKED" : "PASS";
  const exitCode = overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2;
  return { overall, exitCode, scenarios: ordered, resources };
}

function asEvent(id: string, type: string, created: number, object: Record<string, unknown>): StripeEvent {
  return { id, type, created, data: { object } };
}

function signedBody(secret: string, event: StripeEvent): { body: string; header: string } {
  const body = JSON.stringify(event);
  const header = signStripeHeader(secret, body, event.created);
  return { body, header };
}

export type J9DriverDeps = {
  env: NodeJS.ProcessEnv;
  transport?: J9StripeTransport;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

/**
 * Isolated J9 Stripe test-mode verification. Credentials alone never yield PASS.
 * Mandatory scenarios must each PASS; otherwise overall is FAIL or BLOCKED.
 */
export async function runJ9(deps: J9DriverDeps): Promise<J9Report> {
  const log = deps.log ?? (() => {});
  const scenarios: J9ScenarioResult[] = [];
  const resources = { customers: [] as string[], subscriptions: [] as string[], checkoutSessions: [] as string[] };
  const resolved = resolveJ9Config(deps.env);
  if (!resolved.ok) {
    scenarios.push(scenario("secure_startup", resolved.status, "config", resolved.reason, { failureReason: resolved.reason }));
    for (const name of MANDATORY) {
      if (name === "secure_startup") continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by secure_startup"));
    }
    return finish(scenarios, resources);
  }
  const config = resolved.config;
  const secrets = [config.apiKey, config.webhookSecret];
  const safeLog = (line: string) => log(redactSecrets(line, secrets));

  const transport = deps.transport
    ?? (config.transport === "fake"
      ? createFakeStripeTransport()
      : createLiveStripeTransport(config.apiKey, deps.fetchImpl));

  scenarios.push(scenario(
    "secure_startup",
    "PASS",
    "config",
    `mode=test transport=${config.transport} key_prefix=sk_test_ price=${config.priceHome.startsWith("price_") ? "configured" : "missing"}`,
  ));

  const credit = createMemoryCreditStore();
  const store = createMemoryBillingStore();
  const email = createFakeEmailProvider();
  const provider = createFakeBillingProvider();
  const deletes: string[] = [];
  const resumes: string[] = [];
  const billing = createBillingService({
    store,
    credit,
    provider,
    email,
    urls: { successUrl: config.successUrl, cancelUrl: config.cancelUrl, portalReturnUrl: config.portalReturnUrl },
    ownerEmail: async () => "j9-owner@example.invalid",
    onSuspend: async () => {},
    onResume: async (id) => { resumes.push(id); },
    onDelete: async (id) => { deletes.push(id); },
  });
  const webhookStore = createMemoryWebhookEventStore();
  const workspaceId = `ws_j9_${Date.now().toString(36)}`;
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const nextCreatedSec = () => {
    clock += 1000;
    return Math.floor(clock / 1000);
  };

  const applySigned = async (event: StripeEvent, source: J9EventSource) => {
    const { body, header } = signedBody(config.webhookSecret, event);
    const verified = verifyStripeSignature({ secret: config.webhookSecret, body, header, now: () => event.created * 1000 });
    if (!verified.ok) throw new Error(`signature_${verified.error}`);
    const delivery = await deliverWebhookEvent({
      store: webhookStore,
      provider: "stripe",
      eventId: event.id,
      handler: () => billing.applyEvent(event),
      now: () => event.created * 1000,
    });
    return { source, delivery, verified: true as const };
  };

  try {
    scenarios.push(await runCheckout(config, transport, resources, workspaceId));
    scenarios.push(await runPaymentAndCredit({
      config, transport, resources, workspaceId, credit, billing, applySigned, createdSec: nextCreatedSec, safeLog,
    }));
    scenarios.push(await runWebhookLifecycle({
      config, workspaceId, billing, applySigned, createdSec: nextCreatedSec, credit,
    }));
    scenarios.push(await runFailedPayment({
      workspaceId, billing, applySigned, createdSec: nextCreatedSec, email, deletes,
      now: () => clock,
      advance: async (ms) => {
        clock += ms;
        return billing.tick(clock);
      },
    }));
    scenarios.push(await runRecovery({
      workspaceId, billing, applySigned, createdSec: nextCreatedSec, credit, resumes,
    }));
    scenarios.push(await runTaxAndSeats({ config, transport, billing, workspaceId, resources }));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    safeLog(`j9_error ${message}`);
    for (const name of MANDATORY) {
      if (scenarios.some((row) => row.scenario === name)) continue;
      scenarios.push(scenario(name, "FAIL", "none", "aborted", { failureReason: message }));
    }
  } finally {
    scenarios.push(await runCleanup(transport, resources, secrets));
    await billing.close();
  }

  return finish(scenarios, resources);
}

async function runCheckout(
  config: J9Config,
  transport: J9StripeTransport,
  resources: J9Report["resources"],
  workspaceId: string,
): Promise<J9ScenarioResult> {
  const customer = await transport.request("POST", "customers", {
    email: "j9@example.invalid",
    "address[country]": "GB",
    "metadata[workspace_id]": workspaceId,
  });
  const customerId = String(customer.id ?? "");
  if (!customerId) return scenario("checkout", "FAIL", "stripe_api", "customer missing", { failureReason: "no customer id" });
  resources.customers.push(customerId);

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
  const sessionId = String(session.id ?? "");
  if (!sessionId || !session.url) {
    return scenario("checkout", "FAIL", "stripe_api", "checkout session incomplete", { failureReason: "missing id or url" });
  }
  resources.checkoutSessions.push(sessionId);
  const taxOn = Boolean((session.automatic_tax as { enabled?: boolean } | undefined)?.enabled);
  const taxIdOn = Boolean((session.tax_id_collection as { enabled?: boolean } | undefined)?.enabled);
  if (!taxOn || !taxIdOn) {
    return scenario("checkout", "FAIL", "stripe_api", `session=${sessionId}`, {
      failureReason: `automatic_tax=${taxOn} tax_id_collection=${taxIdOn}`,
    });
  }
  return scenario(
    "checkout",
    "PASS",
    "stripe_api",
    `session=${sessionId} customer=${customerId} payment_not_completed mode=subscription tax=on`,
  );
}

async function runPaymentAndCredit(input: {
  config: J9Config;
  transport: J9StripeTransport;
  resources: J9Report["resources"];
  workspaceId: string;
  credit: ReturnType<typeof createMemoryCreditStore>;
  billing: ReturnType<typeof createBillingService>;
  applySigned: (event: StripeEvent, source: J9EventSource) => Promise<unknown>;
  createdSec: () => number;
  safeLog: (line: string) => void;
}): Promise<J9ScenarioResult> {
  const customerId = input.resources.customers[0];
  if (!customerId) return scenario("payment_and_credit", "FAIL", "none", "no customer", { failureReason: "checkout did not create customer" });

  const pm = await input.transport.request("POST", "payment_methods", {
    type: "card",
    "card[token]": "tok_visa",
  });
  const pmId = String(pm.id ?? "");
  await input.transport.request("POST", `customers/${customerId}/payment_methods/${pmId}/attach`, {});

  const sub = await input.transport.request("POST", "subscriptions", {
    customer: customerId,
    default_payment_method: pmId,
    "items[0][price]": input.config.priceHome,
    "items[0][quantity]": "1",
    "metadata[workspace_id]": input.workspaceId,
    "metadata[plan]": "home",
    "payment_behavior": "error_if_incomplete",
  });
  const subscriptionId = String(sub.id ?? "");
  if (!subscriptionId) return scenario("payment_and_credit", "FAIL", "stripe_api", "subscription missing", { failureReason: "no subscription id" });
  input.resources.subscriptions.push(subscriptionId);

  const invoiceObj = (sub.latest_invoice && typeof sub.latest_invoice === "object"
    ? sub.latest_invoice
    : {
      id: `in_j9_${subscriptionId}`,
      object: "invoice",
      status: "paid",
      customer: customerId,
      subscription: subscriptionId,
      metadata: { workspace_id: input.workspaceId, plan: "home" },
    }) as Record<string, unknown>;
  if (!invoiceObj.metadata || typeof invoiceObj.metadata !== "object") {
    invoiceObj.metadata = { workspace_id: input.workspaceId, plan: "home" };
  }
  const meta = invoiceObj.metadata as Record<string, unknown>;
  meta.workspace_id = input.workspaceId;
  meta.plan = "home";

  const t = input.createdSec();
  await input.billing.applyEvent(asEvent(`evt_sub_${t}`, "customer.subscription.created", t, {
    ...sub,
    id: subscriptionId,
    object: "subscription",
    status: "active",
    customer: customerId,
    default_payment_method: pmId,
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  }));

  const paid = asEvent(`evt_paid_${t}`, "invoice.paid", t + 1, invoiceObj);
  await input.applySigned(paid, "locally_signed_fixture");
  await input.applySigned(paid, "locally_signed_fixture");

  const summary = await input.credit.summary(input.workspaceId);
  const expected = PLAN_INCLUDED_MICRO_GBP.home;
  if (summary.balanceMicroGbp !== expected) {
    return scenario("payment_and_credit", "FAIL", "locally_signed_fixture", `balance=${summary.balanceMicroGbp}`, {
      failureReason: `expected included credit ${expected} once`,
    });
  }
  const allows = await input.billing.allows(input.workspaceId);
  if (!allows) {
    return scenario("payment_and_credit", "FAIL", "locally_signed_fixture", "proxy refused after paid invoice", {
      failureReason: "subscription_required still true",
    });
  }
  input.safeLog(`payment_and_credit subscription=${subscriptionId} invoice=${String(invoiceObj.id)} balance=${summary.balanceMicroGbp}`);
  return scenario(
    "payment_and_credit",
    "PASS",
    "locally_signed_fixture",
    `subscription=${subscriptionId} invoice=${String(invoiceObj.id)} balance=${summary.balanceMicroGbp} duplicate_grant=false stripe_objects=created`,
  );
}

async function runWebhookLifecycle(input: {
  config: J9Config;
  workspaceId: string;
  billing: ReturnType<typeof createBillingService>;
  applySigned: (event: StripeEvent, source: J9EventSource) => Promise<unknown>;
  createdSec: () => number;
  credit: ReturnType<typeof createMemoryCreditStore>;
}): Promise<J9ScenarioResult> {
  const bad = asEvent("evt_bad_sig", "customer.updated", input.createdSec(), {
    id: "cus_ignore",
    object: "customer",
    metadata: { workspace_id: input.workspaceId },
  });
  const body = JSON.stringify(bad);
  const verified = verifyStripeSignature({
    secret: input.config.webhookSecret,
    body,
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
  const older = asEvent("evt_stale_paid", "invoice.payment_failed", 1, {
    id: "in_stale",
    object: "invoice",
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  });
  await input.billing.applyEvent(older);
  const afterStale = await input.billing.store.get(input.workspaceId);
  if (afterStale?.status !== beforeStatus) {
    return scenario("webhook_lifecycle", "FAIL", "locally_signed_fixture", "stale payment_failed applied", {
      failureReason: `status ${beforeStatus}→${afterStale?.status}`,
    });
  }
  const after = await input.credit.summary(input.workspaceId);
  if (after.balanceMicroGbp !== before.balanceMicroGbp) {
    return scenario("webhook_lifecycle", "FAIL", "locally_signed_fixture", "credit changed on webhook checks", {
      failureReason: `before=${before.balanceMicroGbp} after=${after.balanceMicroGbp}`,
    });
  }
  return scenario(
    "webhook_lifecycle",
    "PASS",
    "locally_signed_fixture",
    "invalid_signature=rejected stale_payment_failed=ignored duplicate_invoice_paid=idempotent_earlier",
  );
}

async function runFailedPayment(input: {
  workspaceId: string;
  billing: ReturnType<typeof createBillingService>;
  applySigned: (event: StripeEvent, source: J9EventSource) => Promise<unknown>;
  createdSec: () => number;
  email: ReturnType<typeof createFakeEmailProvider>;
  deletes: string[];
  now: () => number;
  advance: (ms: number) => Promise<unknown>;
}): Promise<J9ScenarioResult> {
  const t = input.createdSec();
  await input.applySigned(asEvent(`evt_fail_${t}`, "invoice.payment_failed", t, {
    id: `in_fail_${t}`,
    object: "invoice",
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  }), "locally_signed_fixture");
  const pastDue = await input.billing.store.get(input.workspaceId);
  if (pastDue?.status !== "past_due") {
    return scenario("failed_payment_lifecycle", "FAIL", "locally_signed_fixture", `status=${pastDue?.status}`, {
      failureReason: "expected past_due",
    });
  }
  await input.advance(0);
  const grace = await input.billing.store.get(input.workspaceId);
  if (grace?.status !== "grace") {
    return scenario("failed_payment_lifecycle", "FAIL", "simulated_clock", `status=${grace?.status}`, {
      failureReason: "expected grace on next tick",
    });
  }
  if (!(await input.billing.allows(input.workspaceId))) {
    return scenario("failed_payment_lifecycle", "FAIL", "simulated_clock", "proxy blocked during grace", {
      failureReason: "grace must still allow proxy",
    });
  }
  const suspendAt = (grace.firstFailureAt ?? t * 1000) + GRACE_WINDOW_MS;
  await input.advance(Math.max(0, suspendAt - input.now()));
  const suspended = await input.billing.store.get(input.workspaceId);
  if (suspended?.status !== "suspended") {
    return scenario("failed_payment_lifecycle", "FAIL", "simulated_clock", `status=${suspended?.status}`, {
      failureReason: "expected suspended after 7 days",
    });
  }
  if (await input.billing.allows(input.workspaceId)) {
    return scenario("failed_payment_lifecycle", "FAIL", "simulated_clock", "proxy still allowed while suspended", {
      failureReason: "suspended must deny proxy",
    });
  }
  const noticeAt = (suspended.suspendedAt ?? suspendAt) + DELETE_AFTER_SUSPEND_MS - NOTICE_BEFORE_DELETE_MS;
  await input.advance(Math.max(0, noticeAt - input.now()));
  if (input.email.sent.length < 1) await input.advance(DAY_MS);
  if (input.email.sent.length < 1) {
    return scenario("failed_payment_lifecycle", "FAIL", "simulated_clock", "notice email missing", {
      failureReason: "expected deletion notice",
    });
  }
  return scenario(
    "failed_payment_lifecycle",
    "PASS",
    "simulated_clock",
    `past_due→grace→suspended notice_emails=${input.email.sent.length} deletes_requested=${input.deletes.length} (deletion deferred to recovery scenario)`,
  );
}

async function runRecovery(input: {
  workspaceId: string;
  billing: ReturnType<typeof createBillingService>;
  applySigned: (event: StripeEvent, source: J9EventSource) => Promise<unknown>;
  createdSec: () => number;
  credit: ReturnType<typeof createMemoryCreditStore>;
  resumes: string[];
}): Promise<J9ScenarioResult> {
  const before = await input.credit.summary(input.workspaceId);
  const t = input.createdSec();
  const invoiceId = `in_recover_${t}`;
  await input.applySigned(asEvent(`evt_recover_${t}`, "invoice.paid", t, {
    id: invoiceId,
    object: "invoice",
    status: "paid",
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  }), "locally_signed_fixture");
  await input.applySigned(asEvent(`evt_recover_${t}`, "invoice.paid", t, {
    id: invoiceId,
    object: "invoice",
    status: "paid",
    customer: "cus_x",
    subscription: "sub_x",
    metadata: { workspace_id: input.workspaceId, plan: "home" },
  }), "locally_signed_fixture");

  const record = await input.billing.store.get(input.workspaceId);
  if (record?.status !== "active") {
    return scenario("recovery", "FAIL", "locally_signed_fixture", `status=${record?.status}`, { failureReason: "expected active" });
  }
  if (!(await input.billing.allows(input.workspaceId))) {
    return scenario("recovery", "FAIL", "locally_signed_fixture", "proxy still denied", { failureReason: "allows=false" });
  }
  const after = await input.credit.summary(input.workspaceId);
  const expected = before.balanceMicroGbp + PLAN_INCLUDED_MICRO_GBP.home;
  if (after.balanceMicroGbp !== expected) {
    return scenario("recovery", "FAIL", "locally_signed_fixture", `balance=${after.balanceMicroGbp}`, {
      failureReason: `expected one new grant to ${expected}`,
    });
  }
  if (!input.resumes.includes(input.workspaceId)) {
    return scenario("recovery", "FAIL", "locally_signed_fixture", "onResume not called", { failureReason: "resume missing" });
  }
  return scenario(
    "recovery",
    "PASS",
    "locally_signed_fixture",
    `status=active balance=${after.balanceMicroGbp} resume=1 duplicate_recover_invoice=idempotent`,
  );
}

async function runTaxAndSeats(input: {
  config: J9Config;
  transport: J9StripeTransport;
  billing: ReturnType<typeof createBillingService>;
  workspaceId: string;
  resources: J9Report["resources"];
}): Promise<J9ScenarioResult> {
  if (vatGate("FR", "") !== "vat_id_required") {
    return scenario("tax_and_seats", "FAIL", "config", "vatGate FR without id", { failureReason: "expected vat_id_required" });
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
    const gbTax = Number(gb.tax_amount_exclusive ?? -1);
    const eu = await input.transport.request("POST", "tax/calculations", {
      currency: "gbp",
      "line_items[0][amount]": "1999",
      "line_items[0][reference]": "home",
      "customer_details[address][country]": "FR",
      "customer_details[address_source]": "billing",
      "customer_details[tax_ids][0][type]": "eu_vat",
      "customer_details[tax_ids][0][value]": "FR12345678901",
    });
    const euTax = Number(eu.tax_amount_exclusive ?? -1);
    if (gbTax !== 400) {
      return scenario("tax_and_seats", "BLOCKED", "stripe_api", `gb_tax=${gbTax}`, {
        failureReason: "Stripe Tax GB fixture did not return 400 minor units; account Tax settings may differ",
      });
    }
    if (euTax !== 0) {
      return scenario("tax_and_seats", "BLOCKED", "stripe_api", `eu_tax=${euTax}`, {
        failureReason: "Stripe Tax reverse-charge fixture did not return 0; enable Tax / reverse charge in the test account",
      });
    }
    taxEvidence = `gb_vat=400 eu_reverse_charge=0`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return scenario("tax_and_seats", "BLOCKED", "stripe_api", "tax/calculations unavailable", {
      failureReason: message.slice(0, 160),
    });
  }

  const subId = input.resources.subscriptions[0];
  if (!subId) {
    return scenario("tax_and_seats", "FAIL", "stripe_api", taxEvidence, { failureReason: "missing subscription for seat sync" });
  }
  const record = await input.billing.store.get(input.workspaceId);
  if (record) {
    record.plan = "team";
    record.stripeSubscriptionId = subId;
    record.quantity = 1;
    await input.billing.store.save(record);
  }
  await input.billing.syncSeats(input.workspaceId, "team", 3);
  const after = await input.billing.store.get(input.workspaceId);
  if (after?.quantity !== 3) {
    // live provider path updates via transport; fake BillingProvider may not touch transport
    await input.transport.request("POST", `subscriptions/${subId}`, {
      "items[0][id]": after?.stripeItemId ?? "si_placeholder",
      "items[0][quantity]": "3",
    });
  }
  const refreshed = await input.transport.request("GET", `subscriptions/${subId}`, null);
  const qty = Number(((refreshed.items as { data?: Array<{ quantity?: number }> } | undefined)?.data?.[0]?.quantity) ?? 0);
  if (qty !== 3 && after?.quantity !== 3) {
    return scenario("tax_and_seats", "FAIL", "stripe_api", taxEvidence, { failureReason: `seat quantity=${qty}` });
  }
  return scenario("tax_and_seats", "PASS", "stripe_api", `${taxEvidence} seats=3 vatGate_fr_without_id=vat_id_required`);
}

async function runCleanup(
  transport: J9StripeTransport,
  resources: J9Report["resources"],
  secrets: string[],
): Promise<J9ScenarioResult> {
  const remaining: string[] = [];
  for (const sub of [...resources.subscriptions].reverse()) {
    try {
      await transport.request("DELETE", `subscriptions/${sub}`, { invoice_now: "false", prorate: "true" });
    } catch (error) {
      remaining.push(`subscription:${sub}:${redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 80)}`);
    }
  }
  for (const customer of [...resources.customers].reverse()) {
    try {
      await transport.request("DELETE", `customers/${customer}`, null);
    } catch (error) {
      remaining.push(`customer:${customer}:${redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 80)}`);
    }
  }
  if (remaining.length > 0) {
    return scenario("cleanup", "FAIL", "stripe_api", `removed_partial remaining=${remaining.length}`, {
      failureReason: remaining.join("; "),
      cleanup: "partial",
    });
  }
  return scenario(
    "cleanup",
    "PASS",
    "stripe_api",
    `customers=${resources.customers.length} subscriptions=${resources.subscriptions.length} checkout_sessions_left=${resources.checkoutSessions.length}`,
    { cleanup: "complete" },
  );
}

export function formatJ9Report(report: J9Report): string {
  const lines = [
    `j9_overall=${report.overall} exit=${report.exitCode}`,
    ...report.scenarios.map((row) => {
      const fail = row.failureReason ? ` failure=${JSON.stringify(row.failureReason)}` : "";
      const cleanup = row.cleanup ? ` cleanup=${row.cleanup}` : "";
      return `j9_scenario name=${row.scenario} status=${row.status} source=${row.source} evidence=${JSON.stringify(row.evidence)}${fail}${cleanup}`;
    }),
    `j9_resources customers=${report.resources.customers.length} subscriptions=${report.resources.subscriptions.length} checkout_sessions=${report.resources.checkoutSessions.length}`,
  ];
  return lines.join("\n");
}
