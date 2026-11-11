import { signStripeHeader, verifyStripeSignature, deliverWebhookEvent, createMemoryWebhookEventStore } from "../admin/webhooks.ts";
import { PLAN_INCLUDED_MICRO_GBP } from "../proxy/pricing.ts";
import { createMemoryCreditStore } from "../proxy/credit-store.ts";
import { createBillingService, type StripeEvent } from "./apply.ts";
import { createFakeEmailProvider } from "./email.ts";
import { resolveJ9Config, redactSecrets, type J9Config } from "./j9-config.ts";
import { assertPaidInvoice, invoiceIdFromSubscription, stripeQuantity } from "./j9-invoice.ts";
import {
  cleanupAbandonedRun,
  cleanupTrackedResources,
  prepareLiveJ9,
  resumeLiveCheckoutEvidence,
  runStripeTestClockDunning,
} from "./j9-live-stages.ts";
import {
  createFakeStripeTransport,
  createLiveStripeTransport,
  type FakeStripeTransport,
  type J9StripeTransport,
} from "./j9-transport.ts";
import { createFakeBillingProvider } from "./provider.ts";
import { DAY_MS, GRACE_WINDOW_MS, DELETE_AFTER_SUSPEND_MS, NOTICE_BEFORE_DELETE_MS, emptyRecord } from "./record.ts";
import { createMemoryBillingStore } from "./store.ts";
import { vatGate } from "./plan-prices.ts";
import type { J9RunArtifact, J9TrackedResources } from "./j9-run-artifact.ts";

export type J9ScenarioStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type J9EventSource =
  | "stripe_api"
  | "locally_signed_fixture"
  | "simulated_clock"
  | "config"
  | "none"
  | "stripe_cli_capture";
export type J9Kind = "fake_unit" | "live_j9";

export type J9ScenarioResult = {
  scenario: string;
  status: J9ScenarioStatus;
  source: J9EventSource;
  evidence: string;
  failureReason?: string;
  cleanup?: string;
};

export type J9Report = {
  kind: J9Kind;
  /** True only for a complete live Stripe J9 acceptance run. */
  liveAcceptance: boolean;
  overall: "PASS" | "FAIL" | "BLOCKED";
  exitCode: number;
  scenarios: J9ScenarioResult[];
  resources: J9TrackedResources;
  artifactPath?: string | null;
  runId?: string | null;
  checkoutUrl?: string | null;
};

const SHARED_MANDATORY = [
  "secure_startup",
  "checkout_session_created",
  "checkout_completed",
  "subscription_payment_and_credit",
  "webhook_lifecycle",
  "simulated_failed_payment_lifecycle",
  "simulated_recovery",
  "tax_and_seats",
  "cleanup",
] as const;

const LIVE_ONLY_MANDATORY = ["stripe_dunning_recovery"] as const;

function mandatoryFor(kind: J9Kind): readonly string[] {
  return kind === "live_j9" ? [...SHARED_MANDATORY, ...LIVE_ONLY_MANDATORY] : SHARED_MANDATORY;
}

function scenario(name: string, status: J9ScenarioStatus, source: J9EventSource, evidence: string, extra: Partial<J9ScenarioResult> = {}): J9ScenarioResult {
  return { scenario: name, status, source, evidence, ...extra };
}

export function finish(input: {
  kind: J9Kind;
  scenarios: J9ScenarioResult[];
  resources: J9Report["resources"];
  artifactPath?: string | null;
  runId?: string | null;
  checkoutUrl?: string | null;
}): J9Report {
  const required = mandatoryFor(input.kind);
  const byName = new Map(input.scenarios.map((row) => [row.scenario, row]));
  const ordered = [
    ...required.map((name) => byName.get(name) ?? scenario(name, "NOT_RUN", "none", "not executed")),
    ...input.scenarios.filter((row) => !required.includes(row.scenario)),
  ];
  // Deduplicate while preferring required order.
  const seen = new Set<string>();
  const scenarios = ordered.filter((row) => {
    if (seen.has(row.scenario)) return false;
    seen.add(row.scenario);
    return true;
  });
  const requiredRows = scenarios.filter((row) => required.includes(row.scenario));
  const hasFail = requiredRows.some((row) => row.status === "FAIL");
  const hasBlockedOrSkip = requiredRows.some((row) => row.status === "BLOCKED" || row.status === "NOT_RUN");
  const overall = hasFail ? "FAIL" : hasBlockedOrSkip ? "BLOCKED" : "PASS";
  const exitCode = overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2;
  return {
    kind: input.kind,
    liveAcceptance: input.kind === "live_j9" && overall === "PASS",
    overall,
    exitCode,
    scenarios,
    resources: {
      customers: input.resources.customers,
      subscriptions: input.resources.subscriptions,
      checkoutSessions: input.resources.checkoutSessions,
      testClocks: input.resources.testClocks ?? [],
    },
    artifactPath: input.artifactPath ?? null,
    runId: input.runId ?? null,
    checkoutUrl: input.checkoutUrl ?? null,
  };
}

function emptyResources(): J9TrackedResources {
  return { customers: [], subscriptions: [], checkoutSessions: [], testClocks: [] };
}

function asEvent(id: string, type: string, created: number, object: Record<string, unknown>): StripeEvent {
  return { id, type, created, data: { object } };
}

function signedBody(secret: string, event: StripeEvent): { body: string; header: string } {
  const body = JSON.stringify(event);
  const header = signStripeHeader(secret, body, event.created);
  return { body, header };
}

function isFakeTransport(transport: J9StripeTransport): transport is FakeStripeTransport {
  return typeof (transport as FakeStripeTransport).markCheckoutComplete === "function";
}

export type J9DriverDeps = {
  env: NodeJS.ProcessEnv;
  transport?: J9StripeTransport;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Override repo root for fixed artifacts/j9 paths (tests). */
  repoRoot?: string;
};

/**
 * Isolated J9 verification. Fake-unit PASS is never live acceptance.
 * Live J9 PASS requires every live mandatory scenario, including hosted checkout completion
 * and Stripe dunning coverage.
 */
export async function runJ9(deps: J9DriverDeps): Promise<J9Report> {
  const log = deps.log ?? (() => {});
  const scenarios: J9ScenarioResult[] = [];
  const resources = emptyResources();
  const resolved = resolveJ9Config(deps.env, deps.repoRoot ?? process.cwd());
  const kind: J9Kind = (resolved.ok ? resolved.config.transport : "live") === "fake" ? "fake_unit" : "live_j9";

  if (!resolved.ok) {
    scenarios.push(scenario("secure_startup", resolved.status, "config", resolved.reason, { failureReason: resolved.reason }));
    for (const name of mandatoryFor(kind)) {
      if (name === "secure_startup") continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by secure_startup"));
    }
    return finish({ kind, scenarios, resources });
  }

  const config = resolved.config;
  if (config.transport === "live" && deps.transport && isFakeTransport(deps.transport) && config.stage === "full") {
    // Stage prepare/resume/cleanup unit tests inject a fake transport under live config on purpose.
    scenarios.push(scenario("secure_startup", "FAIL", "config", "live config with fake transport injected", {
      failureReason: "refusing fake transport under live J9 config",
    }));
    for (const name of mandatoryFor("live_j9")) {
      if (name === "secure_startup") continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by secure_startup"));
    }
    return finish({ kind: "live_j9", scenarios, resources });
  }

  const secrets = [config.apiKey, config.webhookSecret, config.artifactHmacSecret];
  const safeLog = (line: string) => log(redactSecrets(line, secrets));
  const transport = deps.transport
    ?? (config.transport === "fake"
      ? createFakeStripeTransport()
      : createLiveStripeTransport(config.apiKey, deps.fetchImpl));

  if (config.stage === "cleanup") {
    const abandoned = await cleanupAbandonedRun({ config, transport });
    return finish({
      kind,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `stage=cleanup confirm=${config.cleanupConfirm}`),
        ...abandoned.scenarios,
      ],
      resources: abandoned.resources,
      artifactPath: config.artifactPath,
      runId: config.cleanupConfirm,
    });
  }

  if (config.stage === "prepare") {
    const prepared = await prepareLiveJ9({ config, transport });
    for (const row of prepared.scenarios) scenarios.push(row);
    for (const name of mandatoryFor(kind)) {
      if (scenarios.some((row) => row.scenario === name)) continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "awaiting_resume_after_manual_checkout"));
    }
    scenarios.push(await cleanupTrackedResources({
      transport,
      resources: prepared.resources,
      secrets,
      pauseCleanup: prepared.artifact.pauseCleanup,
      artifact: prepared.artifact,
      hmacSecret: config.artifactHmacSecret,
      artifactPath: config.artifactPath,
    }));
    if (prepared.checkoutUrl) safeLog(`j9_prepare checkout_url=${prepared.checkoutUrl} artifact=${config.artifactPath}`);
    return finish({
      kind: "live_j9",
      scenarios,
      resources: prepared.resources,
      artifactPath: config.artifactPath,
      runId: prepared.artifact.runId,
      checkoutUrl: prepared.checkoutUrl,
    });
  }

  let liveArtifact: J9RunArtifact | null = null;
  let resumeCheckoutSub: string | null = null;
  let resumeCheckoutInvoice: string | null = null;
  let webhookFromCapture = false;

  if (config.stage === "resume") {
    const resumed = await resumeLiveCheckoutEvidence({ config, transport });
    if (!resumed.ok) {
      for (const row of resumed.scenarios) scenarios.push(row);
      for (const name of mandatoryFor(kind)) {
        if (scenarios.some((row) => row.scenario === name)) continue;
        scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by resume"));
      }
      const retained = resumed.resources;
      scenarios.push(await cleanupTrackedResources({
        transport,
        resources: retained,
        secrets,
        pauseCleanup: true,
        artifact: resumed.artifact,
        hmacSecret: config.artifactHmacSecret,
        artifactPath: config.artifactPath,
      }));
      return finish({
        kind: "live_j9",
        scenarios,
        resources: retained,
        artifactPath: config.artifactPath,
        runId: resumed.artifact?.runId ?? null,
      });
    }
    for (const row of resumed.evidence.scenarios) scenarios.push(row);
    Object.assign(resources, resumed.evidence.resources);
    liveArtifact = resumed.evidence.artifact;
    resumeCheckoutSub = resumed.evidence.checkoutSubscriptionId;
    resumeCheckoutInvoice = resumed.evidence.checkoutInvoiceId;
    webhookFromCapture = resumed.evidence.webhookCaptureOk;
  } else {
    scenarios.push(scenario(
      "secure_startup",
      "PASS",
      "config",
      `kind=${kind} mode=test transport=${config.transport} stage=${config.stage} key_prefix=sk_test_ price=configured`,
    ));
  }

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
  const workspaceId = liveArtifact?.workspaceId ?? `ws_j9_${Date.now().toString(36)}`;
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const nextCreatedSec = () => {
    clock += 1000;
    return Math.floor(clock / 1000);
  };

  const applySignedFixture = async (event: StripeEvent) => {
    const { body, header } = signedBody(config.webhookSecret, event);
    const verified = verifyStripeSignature({ secret: config.webhookSecret, body, header, now: () => event.created * 1000 });
    if (!verified.ok) throw new Error(`signature_${verified.error}`);
    return deliverWebhookEvent({
      store: webhookStore,
      provider: "stripe",
      eventId: event.id,
      handler: () => billing.applyEvent(event),
      now: () => event.created * 1000,
    });
  };

  try {
    if (config.stage !== "resume") {
      scenarios.push(await runCheckoutSessionCreated(config, transport, resources, workspaceId, billing));
      scenarios.push(await runCheckoutCompleted(kind, transport, resources));
      scenarios.push(await runSubscriptionPaymentAndCredit({
        config, transport, resources, workspaceId, credit, billing, applySignedFixture, createdSec: nextCreatedSec, safeLog,
      }));
    } else if (resumeCheckoutSub && resumeCheckoutInvoice && liveArtifact) {
      const record = (await billing.store.get(workspaceId)) ?? emptyRecord(workspaceId);
      record.stripeCustomerId = liveArtifact.checkout.customerId;
      record.plan = "home";
      record.country = "GB";
      await billing.store.save(record);
      scenarios.push(await runCheckoutSubscriptionPaymentAndCredit({
        config,
        transport,
        workspaceId,
        customerId: liveArtifact.checkout.customerId,
        subscriptionId: resumeCheckoutSub,
        invoiceId: resumeCheckoutInvoice,
        credit,
        billing,
        applySignedFixture,
        createdSec: nextCreatedSec,
        safeLog,
      }));
    } else {
      scenarios.push(scenario("subscription_payment_and_credit", "FAIL", "none", "checkout subscription missing on resume", {
        failureReason: "checkout_subscription_required",
      }));
    }
    if (!(config.stage === "resume" && webhookFromCapture)) {
      scenarios.push(await runWebhookLifecycle({
        config, workspaceId, billing, credit, createdSec: nextCreatedSec, kind,
      }));
    }
    scenarios.push(await runSimulatedFailedPayment({
      workspaceId, billing, applySignedFixture, createdSec: nextCreatedSec, email, deletes,
      now: () => clock,
      advance: async (ms) => {
        clock += ms;
        return billing.tick(clock);
      },
    }));
    scenarios.push(await runSimulatedRecovery({
      workspaceId, billing, applySignedFixture, createdSec: nextCreatedSec, credit, resumes,
    }));
    scenarios.push(await runStripeDunning({ kind, transport, artifact: liveArtifact, sleepMs: config.transport === "live" ? 250 : 0 }));
    scenarios.push(await runTaxAndSeats({ config, transport, resources }));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    safeLog(`j9_error ${message}`);
    for (const name of mandatoryFor(kind)) {
      if (scenarios.some((row) => row.scenario === name)) continue;
      scenarios.push(scenario(name, "FAIL", "none", "aborted", { failureReason: message }));
    }
  } finally {
    scenarios.push(await cleanupTrackedResources({
      transport,
      resources,
      secrets,
      pauseCleanup: false,
      artifact: liveArtifact,
      hmacSecret: config.artifactHmacSecret,
      artifactPath: config.artifactPath,
    }));
    await billing.close();
  }

  return finish({
    kind,
    scenarios,
    resources,
    artifactPath: config.artifactPath,
    runId: liveArtifact?.runId ?? null,
  });
}

async function runCheckoutSessionCreated(
  config: J9Config,
  transport: J9StripeTransport,
  resources: J9Report["resources"],
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

async function runCheckoutCompleted(
  kind: J9Kind,
  transport: J9StripeTransport,
  resources: J9Report["resources"],
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
async function runCheckoutSubscriptionPaymentAndCredit(input: {
  config: J9Config;
  transport: J9StripeTransport;
  workspaceId: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  credit: ReturnType<typeof createMemoryCreditStore>;
  billing: ReturnType<typeof createBillingService>;
  applySignedFixture: (event: StripeEvent) => Promise<unknown>;
  createdSec: () => number;
  safeLog: (line: string) => void;
}): Promise<J9ScenarioResult> {
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
    return scenario("subscription_payment_and_credit", "FAIL", "stripe_api", `invoice=${input.invoiceId}`, {
      failureReason: paid.ok ? "checkout_invoice_id_mismatch" : paid.reason,
    });
  }
  const t = input.createdSec();
  await input.billing.applyEvent(asEvent(`evt_checkout_sub_${t}`, "customer.subscription.created", t, {
    id: input.subscriptionId,
    object: "subscription",
    status: String(sub.status ?? "active"),
    customer: input.customerId,
    metadata: (sub.metadata as Record<string, unknown> | undefined) ?? { workspace_id: input.workspaceId, plan: "home" },
    items: sub.items,
  }));
  const paidEvent = asEvent(`evt_checkout_paid_${t}`, "invoice.paid", t + 1, invoice);
  await input.applySignedFixture(paidEvent);
  await input.applySignedFixture(paidEvent);
  const summary = await input.credit.summary(input.workspaceId);
  const expected = PLAN_INCLUDED_MICRO_GBP.home;
  if (summary.balanceMicroGbp !== expected) {
    return scenario("subscription_payment_and_credit", "FAIL", "locally_signed_fixture", `balance=${summary.balanceMicroGbp}`, {
      failureReason: `expected included credit ${expected} once from checkout invoice`,
    });
  }
  if (!(await input.billing.allows(input.workspaceId))) {
    return scenario("subscription_payment_and_credit", "FAIL", "locally_signed_fixture", "proxy refused", {
      failureReason: "subscription_required",
    });
  }
  input.safeLog(`checkout_payment_and_credit subscription=${input.subscriptionId} invoice=${paid.invoiceId}`);
  return scenario(
    "subscription_payment_and_credit",
    "PASS",
    "stripe_api",
    `subscription=${input.subscriptionId} invoice=${paid.invoiceId} source=checkout_session_subscription separate_api_subscription=false balance=${summary.balanceMicroGbp}`,
  );
}

async function runSubscriptionPaymentAndCredit(input: {
  config: J9Config;
  transport: J9StripeTransport;
  resources: J9Report["resources"];
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

async function runWebhookLifecycle(input: {
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

async function runSimulatedFailedPayment(input: {
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

async function runSimulatedRecovery(input: {
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

async function runStripeDunning(input: {
  kind: J9Kind;
  transport: J9StripeTransport;
  artifact: J9RunArtifact | null;
  sleepMs: number;
}): Promise<J9ScenarioResult> {
  if (input.kind === "fake_unit") {
    return scenario(
      "stripe_dunning_recovery",
      "NOT_RUN",
      "none",
      "not required for fake_unit acceptance; real Stripe Test Clock dunning remains a live_j9 requirement",
    );
  }
  if (!input.artifact?.clock.subscriptionId) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "none", "live stage artifact with Test Clock subscription required", {
      failureReason: "Run STRIPE_J9_STAGE=prepare then resume after Checkout; Test Clock dunning is not available on single-shot full live runs without an artifact",
    });
  }
  return runStripeTestClockDunning({
    transport: input.transport,
    artifact: input.artifact,
    sleepMs: input.sleepMs,
  });
}

async function runTaxAndSeats(input: {
  config: J9Config;
  transport: J9StripeTransport;
  resources: J9Report["resources"];
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

export function formatJ9Report(report: J9Report): string {
  return [
    `j9_kind=${report.kind} live_acceptance=${report.liveAcceptance} overall=${report.overall} exit=${report.exitCode}`,
    report.runId ? `j9_run_id=${report.runId}` : null,
    report.artifactPath ? `j9_artifact=${report.artifactPath}` : null,
    report.checkoutUrl ? `j9_checkout_url=${report.checkoutUrl}` : null,
    ...report.scenarios.map((row) => {
      const fail = row.failureReason ? ` failure=${JSON.stringify(row.failureReason)}` : "";
      const cleanup = row.cleanup ? ` cleanup=${row.cleanup}` : "";
      return `j9_scenario name=${row.scenario} status=${row.status} source=${row.source} evidence=${JSON.stringify(row.evidence)}${fail}${cleanup}`;
    }),
    `j9_resources customers=${report.resources.customers.length} subscriptions=${report.resources.subscriptions.length} checkout_sessions=${report.resources.checkoutSessions.length} test_clocks=${report.resources.testClocks.length}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}
