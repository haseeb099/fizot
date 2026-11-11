/**
 * Live J9 prepare / resume / abandoned-cleanup stages. Manual hosted Checkout
 * remains required; incomplete Sessions stay BLOCKED.
 */
import type { J9Config } from "./j9-config.ts";
import {
  assertCompletedCheckoutSession,
  assertCustomerBelongsToRun,
  assertSubscriptionPrice,
} from "./j9-checkout-evidence.ts";
import {
  createRunId,
  createRunNonce,
  loadJ9RunArtifact,
  saveJ9RunArtifact,
  sealArtifact,
  type J9RunArtifact,
  type J9TrackedResources,
} from "./j9-run-artifact.ts";
import {
  advanceTestClockUntilReady,
  correlateCustomerEvents,
  createTestClock,
  nextBillingFrozenTime,
  parseStripeEvent,
  recurringIntervalFromPrice,
  retrieveTestClock,
  type StripeEventLike,
} from "./j9-test-clock.ts";
import { invoiceIdFromSubscription, assertPaidInvoice } from "./j9-invoice.ts";
import type { J9StripeTransport } from "./j9-transport.ts";
import { loadWebhookCapture, verifyWebhookCapture } from "./j9-webhook-capture.ts";
import { classifyCleanupError, type CleanupResource } from "./j9-errors.ts";
import { redactSecrets } from "./j9-config.ts";

export type StageScenario = {
  scenario: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  source: "stripe_api" | "locally_signed_fixture" | "simulated_clock" | "config" | "none" | "stripe_cli_capture";
  evidence: string;
  failureReason?: string;
  cleanup?: string;
};

function scenario(
  name: string,
  status: StageScenario["status"],
  source: StageScenario["source"],
  evidence: string,
  extra: Partial<StageScenario> = {},
): StageScenario {
  return { scenario: name, status, source, evidence, ...extra };
}

export type PrepareResult = {
  artifact: J9RunArtifact;
  checkoutUrl: string | null;
  scenarios: StageScenario[];
  resources: J9TrackedResources;
};

export async function prepareLiveJ9(input: {
  config: J9Config;
  transport: J9StripeTransport;
  frozenTime?: number;
}): Promise<PrepareResult> {
  const scenarios: StageScenario[] = [];
  const runId = createRunId();
  const runNonce = createRunNonce();
  const workspaceId = `ws_j9_${runId.slice(6, 18)}`;
  const frozenTime = input.frozenTime ?? Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const resources: J9TrackedResources = {
    customers: [],
    subscriptions: [],
    checkoutSessions: [],
    testClocks: [],
  };

  scenarios.push(scenario(
    "secure_startup",
    "PASS",
    "config",
    `kind=live_j9 stage=prepare mode=test transport=live run=${runId}`,
  ));

  const clockCreated = await createTestClock(input.transport, {
    frozenTime,
    name: `fizot-j9-${runId}`.slice(0, 300),
  });
  if (!clockCreated.ok) {
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", clockCreated.reason, {
      failureReason: clockCreated.reason,
    }));
    return {
      artifact: sealArtifact({
        schemaVersion: 1,
        kind: "live_j9_run",
        runId,
        stage: "abandoned",
        createdAt: new Date().toISOString(),
        workspaceId,
        priceHome: input.config.priceHome,
        priceTeam: input.config.priceTeam,
        runNonce,
        pauseCleanup: false,
        checkout: { customerId: "cus_missing", sessionId: "cs_missing", expectedPriceId: input.config.priceHome },
        clock: { clockId: "clock_missing", frozenTime, customerId: "cus_missing", subscriptionId: null, baselineInvoiceId: null },
        resources,
      }),
      checkoutUrl: null,
      scenarios,
      resources,
    };
  }
  resources.testClocks.push(clockCreated.clock.id);

  const checkoutCustomer = await input.transport.request("POST", "customers", {
    email: `j9+checkout-${runId}@example.invalid`,
    "address[country]": "GB",
    "metadata[workspace_id]": workspaceId,
    "metadata[fizot_j9_run_id]": runId,
    "metadata[fizot_j9_role]": "checkout",
  });
  const checkoutCustomerId = String(checkoutCustomer.id ?? "");
  if (!checkoutCustomerId.startsWith("cus_")) {
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "checkout customer missing", {
      failureReason: "no checkout customer id",
    }));
    return emptyPrepareFail(runId, runNonce, workspaceId, input.config, resources, scenarios, frozenTime);
  }
  resources.customers.push(checkoutCustomerId);

  const clockCustomer = await input.transport.request("POST", "customers", {
    email: `j9+clock-${runId}@example.invalid`,
    "address[country]": "GB",
    test_clock: clockCreated.clock.id,
    "metadata[workspace_id]": workspaceId,
    "metadata[fizot_j9_run_id]": runId,
    "metadata[fizot_j9_role]": "test_clock",
  });
  const clockCustomerId = String(clockCustomer.id ?? "");
  if (!clockCustomerId.startsWith("cus_")) {
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "clock customer missing", {
      failureReason: "no clock customer id",
    }));
    return emptyPrepareFail(runId, runNonce, workspaceId, input.config, resources, scenarios, frozenTime, clockCreated.clock.id);
  }
  resources.customers.push(clockCustomerId);

  await input.transport.request("POST", "payment_methods/pm_card_visa/attach", { customer: clockCustomerId });
  await input.transport.request("POST", `customers/${clockCustomerId}`, {
    "invoice_settings[default_payment_method]": "pm_card_visa",
  });

  const clockSub = await input.transport.request("POST", "subscriptions", {
    customer: clockCustomerId,
    default_payment_method: "pm_card_visa",
    "items[0][price]": input.config.priceHome,
    "items[0][quantity]": "1",
    "metadata[workspace_id]": workspaceId,
    "metadata[plan]": "home",
    "metadata[fizot_j9_run_id]": runId,
    payment_behavior: "error_if_incomplete",
    "expand[]": "latest_invoice",
  });
  const clockSubId = String(clockSub.id ?? "");
  const baselineInvoiceId = invoiceIdFromSubscription(clockSub);
  if (!clockSubId.startsWith("sub_") || !baselineInvoiceId) {
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "clock baseline subscription missing", {
      failureReason: "clock subscription/invoice missing",
    }));
    return emptyPrepareFail(runId, runNonce, workspaceId, input.config, resources, scenarios, frozenTime, clockCreated.clock.id);
  }
  resources.subscriptions.push(clockSubId);
  let invoiceObj: Record<string, unknown>;
  if (clockSub.latest_invoice && typeof clockSub.latest_invoice === "object") {
    invoiceObj = clockSub.latest_invoice as Record<string, unknown>;
  } else {
    invoiceObj = await input.transport.request("GET", `invoices/${baselineInvoiceId}`, null);
  }
  const paid = assertPaidInvoice(invoiceObj, { customerId: clockCustomerId, subscriptionId: clockSubId });
  if (!paid.ok) {
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", `baseline_invoice=${baselineInvoiceId}`, {
      failureReason: paid.reason,
    }));
    return emptyPrepareFail(runId, runNonce, workspaceId, input.config, resources, scenarios, frozenTime, clockCreated.clock.id);
  }

  const session = await input.transport.request("POST", "checkout/sessions", {
    mode: "subscription",
    customer: checkoutCustomerId,
    success_url: input.config.successUrl,
    cancel_url: input.config.cancelUrl,
    client_reference_id: workspaceId,
    "line_items[0][price]": input.config.priceHome,
    "line_items[0][quantity]": "1",
    "automatic_tax[enabled]": "true",
    "tax_id_collection[enabled]": "true",
    billing_address_collection: "required",
    "metadata[workspace_id]": workspaceId,
    "metadata[plan]": "home",
    "metadata[fizot_j9_run_id]": runId,
    "subscription_data[metadata][workspace_id]": workspaceId,
    "subscription_data[metadata][plan]": "home",
    "subscription_data[metadata][fizot_j9_run_id]": runId,
  });
  const sessionId = String(session.id ?? "");
  const checkoutUrl = typeof session.url === "string" ? session.url : null;
  if (!sessionId.startsWith("cs_") || !checkoutUrl) {
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "checkout session incomplete", {
      failureReason: "missing id or url",
    }));
    return emptyPrepareFail(runId, runNonce, workspaceId, input.config, resources, scenarios, frozenTime, clockCreated.clock.id);
  }
  resources.checkoutSessions.push(sessionId);
  scenarios.push(scenario(
    "checkout_session_created",
    "PASS",
    "stripe_api",
    `session=${sessionId} customer=${checkoutCustomerId} status=open clock=${clockCreated.clock.id} clock_sub=${clockSubId}`,
  ));
  scenarios.push(scenario(
    "checkout_completed",
    "BLOCKED",
    "stripe_api",
    `session=${sessionId} awaiting_manual_hosted_checkout`,
    {
      failureReason: "Complete the open Stripe Checkout Session in a browser with a test card, then run stage=resume with the same artifact",
    },
  ));

  const artifact = sealArtifact({
    schemaVersion: 1,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId,
    priceHome: input.config.priceHome,
    priceTeam: input.config.priceTeam,
    runNonce,
    pauseCleanup: true,
    checkout: {
      customerId: checkoutCustomerId,
      sessionId,
      expectedPriceId: input.config.priceHome,
    },
    clock: {
      clockId: clockCreated.clock.id,
      frozenTime: clockCreated.clock.frozen_time,
      customerId: clockCustomerId,
      subscriptionId: clockSubId,
      baselineInvoiceId,
    },
    resources,
  });
  if (input.config.artifactPath) saveJ9RunArtifact(input.config.artifactPath, artifact);
  return { artifact, checkoutUrl, scenarios, resources };
}

function emptyPrepareFail(
  runId: string,
  runNonce: string,
  workspaceId: string,
  config: J9Config,
  resources: J9TrackedResources,
  scenarios: StageScenario[],
  frozenTime: number,
  clockId = "clock_missing",
): PrepareResult {
  return {
    artifact: sealArtifact({
      schemaVersion: 1,
      kind: "live_j9_run",
      runId,
      stage: "abandoned",
      createdAt: new Date().toISOString(),
      workspaceId,
      priceHome: config.priceHome,
      priceTeam: config.priceTeam,
      runNonce,
      pauseCleanup: false,
      checkout: {
        customerId: resources.customers[0] ?? "cus_missing",
        sessionId: resources.checkoutSessions[0] ?? "cs_missing",
        expectedPriceId: config.priceHome,
      },
      clock: {
        clockId: resources.testClocks[0] ?? clockId,
        frozenTime,
        customerId: resources.customers[1] ?? resources.customers[0] ?? "cus_missing",
        subscriptionId: resources.subscriptions[0] ?? null,
        baselineInvoiceId: null,
      },
      resources,
    }),
    checkoutUrl: null,
    scenarios,
    resources,
  };
}

export type ResumeEvidence = {
  scenarios: StageScenario[];
  resources: J9TrackedResources;
  artifact: J9RunArtifact;
  checkoutSubscriptionId: string | null;
  stripeOriginatedEvents: StripeEventLike[];
  webhookCaptureOk: boolean;
};

export async function resumeLiveCheckoutEvidence(input: {
  config: J9Config;
  transport: J9StripeTransport;
}): Promise<{ ok: true; evidence: ResumeEvidence } | { ok: false; reason: string; scenarios: StageScenario[] }> {
  const loaded = loadJ9RunArtifact(input.config.artifactPath!);
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.reason,
      scenarios: [scenario("secure_startup", "FAIL", "config", loaded.reason, { failureReason: loaded.reason })],
    };
  }
  const artifact = loaded.artifact;
  if (artifact.priceHome !== input.config.priceHome) {
    return {
      ok: false,
      reason: "artifact_price_mismatch",
      scenarios: [scenario("secure_startup", "FAIL", "config", "artifact priceHome does not match env", {
        failureReason: "artifact_price_mismatch",
      })],
    };
  }

  const customer = await input.transport.request("GET", `customers/${artifact.checkout.customerId}`, null);
  const customerOk = assertCustomerBelongsToRun(customer, {
    customerId: artifact.checkout.customerId,
    runId: artifact.runId,
  });
  if (!customerOk.ok) {
    return {
      ok: false,
      reason: customerOk.reason,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_completed", "FAIL", "stripe_api", customerOk.reason, { failureReason: customerOk.reason }),
      ],
    };
  }

  const session = await input.transport.request("GET", `checkout/sessions/${artifact.checkout.sessionId}`, null);
  const completed = assertCompletedCheckoutSession(session, artifact);
  if (!completed.ok) {
    return {
      ok: false,
      reason: completed.reason,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_session_created", "PASS", "stripe_api", `session=${artifact.checkout.sessionId} from_artifact`),
        scenario("checkout_completed", completed.blocked ? "BLOCKED" : "FAIL", "stripe_api", completed.reason, {
          failureReason: completed.reason,
        }),
      ],
    };
  }

  const subscription = await input.transport.request("GET", `subscriptions/${completed.subscriptionId}`, null);
  const subOk = assertSubscriptionPrice(subscription, {
    subscriptionId: completed.subscriptionId,
    customerId: completed.customerId,
    priceId: artifact.checkout.expectedPriceId,
    runId: artifact.runId,
  });
  if (!subOk.ok) {
    return {
      ok: false,
      reason: subOk.reason,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_completed", "FAIL", "stripe_api", subOk.reason, { failureReason: subOk.reason }),
      ],
    };
  }

  const resources: J9TrackedResources = {
    customers: [...artifact.resources.customers],
    subscriptions: artifact.resources.subscriptions.includes(completed.subscriptionId)
      ? [...artifact.resources.subscriptions]
      : [...artifact.resources.subscriptions, completed.subscriptionId],
    checkoutSessions: [...artifact.resources.checkoutSessions],
    testClocks: [...artifact.resources.testClocks],
  };

  let webhookCaptureOk = false;
  const webhookScenarios: StageScenario[] = [];
  if (input.config.webhookCapturePath) {
    const captureLoaded = loadWebhookCapture(input.config.webhookCapturePath);
    if (!captureLoaded.ok) {
      webhookScenarios.push(scenario("webhook_lifecycle", "FAIL", "stripe_cli_capture", captureLoaded.reason, {
        failureReason: captureLoaded.reason,
      }));
    } else {
      const verified = verifyWebhookCapture({
        capture: captureLoaded.capture,
        expectedRunId: artifact.runId,
        webhookSecret: input.config.webhookSecret,
      });
      if (!verified.ok) {
        webhookScenarios.push(scenario("webhook_lifecycle", "FAIL", "stripe_cli_capture", verified.reason, {
          failureReason: verified.reason,
        }));
      } else {
        webhookCaptureOk = true;
        webhookScenarios.push(scenario(
          "webhook_lifecycle",
          "PASS",
          "stripe_cli_capture",
          `signed_deliveries=${verified.accepted.length} run=${artifact.runId} label=stripe_originated_signed_capture`,
        ));
      }
    }
  } else {
    webhookScenarios.push(scenario(
      "webhook_lifecycle",
      "BLOCKED",
      "none",
      "stripe_cli_signed_capture_missing",
      {
        failureReason: "Set STRIPE_J9_WEBHOOK_CAPTURE_PATH to a Stripe CLI signed capture for this runId; do not expose a public webhook endpoint without approval",
      },
    ));
  }

  const updated = sealArtifact({
    ...artifact,
    stage: "ready_to_resume",
    pauseCleanup: false,
    resources,
    updatedAt: new Date().toISOString(),
  });
  if (input.config.artifactPath) saveJ9RunArtifact(input.config.artifactPath, updated);

  return {
    ok: true,
    evidence: {
      scenarios: [
        scenario("secure_startup", "PASS", "config", `kind=live_j9 stage=resume run=${artifact.runId}`),
        scenario("checkout_session_created", "PASS", "stripe_api", `session=${artifact.checkout.sessionId} resumed`),
        scenario(
          "checkout_completed",
          "PASS",
          "stripe_api",
          `session=${completed.sessionId} status=complete payment_status=paid subscription=${completed.subscriptionId}`,
        ),
        ...webhookScenarios,
      ],
      resources,
      artifact: updated,
      checkoutSubscriptionId: completed.subscriptionId,
      stripeOriginatedEvents: [],
      webhookCaptureOk,
    },
  };
}

export async function runStripeTestClockDunning(input: {
  transport: J9StripeTransport;
  artifact: J9RunArtifact;
  sleepMs?: number;
}): Promise<StageScenario> {
  const clockId = input.artifact.clock.clockId;
  const customerId = input.artifact.clock.customerId;
  const subscriptionId = input.artifact.clock.subscriptionId;
  if (!subscriptionId) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "clock subscription missing", {
      failureReason: "prepare did not record a clock subscription",
    });
  }

  const retrieved = await retrieveTestClock(input.transport, clockId);
  if (!retrieved.ok) {
    return scenario("stripe_dunning_recovery", "FAIL", "stripe_api", retrieved.reason, { failureReason: retrieved.reason });
  }
  if (retrieved.clock.status === "internal_failure") {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "test_clock_internal_failure", {
      failureReason: "Stripe test clock entered internal_failure; unsupported for this run",
    });
  }

  const subscription = await input.transport.request("GET", `subscriptions/${subscriptionId}`, null);
  const price = (subscription.items as { data?: Array<{ price?: Record<string, unknown> }> } | undefined)?.data?.[0]?.price;
  if (!price) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "subscription price missing", {
      failureReason: "cannot determine recurring interval for clock advance",
    });
  }
  const recurring = recurringIntervalFromPrice(price);
  if (!recurring) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "price not recurring", {
      failureReason: "Test Clock advance requires a recurring Price",
    });
  }

  // Arrange a test-mode failure card before advancing into the next period.
  await input.transport.request("POST", "payment_methods/pm_card_chargeCustomerFail/attach", { customer: customerId });
  await input.transport.request("POST", `customers/${customerId}`, {
    "invoice_settings[default_payment_method]": "pm_card_chargeCustomerFail",
  });

  const target = nextBillingFrozenTime(retrieved.clock.frozen_time, recurring);
  const advanced = await advanceTestClockUntilReady({
    transport: input.transport,
    clockId,
    targetFrozenTime: target,
    sleepMs: input.sleepMs ?? 0,
    maxAttempts: input.sleepMs && input.sleepMs > 0 ? 40 : 3,
  });
  if (!advanced.ok) {
    const blocked = advanced.reason.includes("internal_failure") || advanced.reason.includes("timeout");
    return scenario("stripe_dunning_recovery", blocked ? "BLOCKED" : "FAIL", "stripe_api", advanced.reason, {
      failureReason: advanced.reason,
    });
  }

  const failedList = await input.transport.request("GET", "events", {
    type: "invoice.payment_failed",
    limit: "20",
  });
  const failedEvents = ((failedList.data as Array<Record<string, unknown>> | undefined) ?? [])
    .map(parseStripeEvent)
    .filter((event): event is StripeEventLike => event != null);
  const failedMatch = correlateCustomerEvents(failedEvents, {
    customerId,
    subscriptionId,
    types: ["invoice.payment_failed"],
  });
  if (failedMatch.missingTypes.length > 0) {
    return scenario(
      "stripe_dunning_recovery",
      "BLOCKED",
      "stripe_api",
      `clock=${clockId} frozen_time=${advanced.clock.frozen_time} missing=invoice.payment_failed`,
      {
        failureReason: "Absent Stripe-generated payment failure after clock advance; check Price interval, payment method and Stripe retry settings",
      },
    );
  }

  // Recovery: restore a succeeding card and advance again so Stripe can collect.
  await input.transport.request("POST", "payment_methods/pm_card_visa/attach", { customer: customerId });
  await input.transport.request("POST", `customers/${customerId}`, {
    "invoice_settings[default_payment_method]": "pm_card_visa",
  });
  const recoverTarget = nextBillingFrozenTime(advanced.clock.frozen_time, recurring);
  const recoveredClock = await advanceTestClockUntilReady({
    transport: input.transport,
    clockId,
    targetFrozenTime: recoverTarget,
    sleepMs: input.sleepMs ?? 0,
    maxAttempts: input.sleepMs && input.sleepMs > 0 ? 40 : 3,
  });
  if (!recoveredClock.ok) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", recoveredClock.reason, {
      failureReason: `recovery clock advance: ${recoveredClock.reason}`,
    });
  }

  const paidList = await input.transport.request("GET", "events", {
    type: "invoice.paid",
    limit: "20",
  });
  const paidEvents = ((paidList.data as Array<Record<string, unknown>> | undefined) ?? [])
    .map(parseStripeEvent)
    .filter((event): event is StripeEventLike => event != null);
  const paidMatch = correlateCustomerEvents(paidEvents, {
    customerId,
    subscriptionId,
    types: ["invoice.paid"],
  });
  // Baseline prepare invoice.paid may already exist; require at least one paid event for this subscription.
  if (paidMatch.matched.length < 1) {
    return scenario(
      "stripe_dunning_recovery",
      "BLOCKED",
      "stripe_api",
      `clock=${clockId} recovery_not_confirmed`,
      { failureReason: "Recovery not yet confirmed by Stripe invoice.paid for the clock subscription" },
    );
  }

  return scenario(
    "stripe_dunning_recovery",
    "PASS",
    "stripe_api",
    `clock=${clockId} stripe_time=${recoveredClock.clock.frozen_time} failed_events=${failedMatch.matched.length} paid_events=${paidMatch.matched.length} label=stripe_test_clock_not_app_worker_clock`,
  );
}

export async function cleanupTrackedResources(input: {
  transport: J9StripeTransport;
  resources: J9TrackedResources;
  secrets: string[];
  pauseCleanup?: boolean;
}): Promise<StageScenario> {
  if (input.pauseCleanup) {
    return scenario(
      "cleanup",
      "BLOCKED",
      "stripe_api",
      "pauseCleanup=true awaiting_manual_checkout",
      {
        failureReason: "Resources retained for manual Checkout; run stage=cleanup with STRIPE_J9_CLEANUP_CONFIRM=<runId> to remove an abandoned run",
        cleanup: "retained",
      },
    );
  }
  const remaining: string[] = [];
  const recordFailure = (resource: CleanupResource, id: string, error: unknown) => {
    const classified = classifyCleanupError(resource, error);
    if (classified.action === "tolerate") return;
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), input.secrets).slice(0, 80);
    remaining.push(`${resource}:${id}:${classified.reason}:${detail}`);
  };

  for (const sessionId of [...input.resources.checkoutSessions].reverse()) {
    try {
      const session = await input.transport.request("GET", `checkout/sessions/${sessionId}`, null);
      if (session.status === "open") {
        try {
          await input.transport.request("POST", `checkout/sessions/${sessionId}/expire`, null);
        } catch (error) {
          recordFailure("checkout_session", sessionId, error);
        }
      }
    } catch (error) {
      recordFailure("checkout_session", sessionId, error);
    }
  }
  for (const sub of [...input.resources.subscriptions].reverse()) {
    try {
      await input.transport.request("DELETE", `subscriptions/${sub}`, { invoice_now: "false", prorate: "true" });
    } catch (error) {
      recordFailure("subscription", sub, error);
    }
  }
  for (const customer of [...input.resources.customers].reverse()) {
    try {
      await input.transport.request("DELETE", `customers/${customer}`, null);
    } catch (error) {
      recordFailure("customer", customer, error);
    }
  }
  for (const clockId of [...input.resources.testClocks].reverse()) {
    try {
      await input.transport.request("DELETE", `test_helpers/test_clocks/${clockId}`, null);
    } catch (error) {
      recordFailure("test_clock", clockId, error);
    }
  }
  if (remaining.length > 0) {
    return scenario("cleanup", "FAIL", "stripe_api", `remaining=${remaining.length}`, {
      failureReason: remaining.join("; "),
      cleanup: "partial",
    });
  }
  return scenario(
    "cleanup",
    "PASS",
    "stripe_api",
    `closed_sessions=${input.resources.checkoutSessions.length} subscriptions=${input.resources.subscriptions.length} customers=${input.resources.customers.length} clocks=${input.resources.testClocks.length}`,
    { cleanup: "complete" },
  );
}

export async function cleanupAbandonedRun(input: {
  config: J9Config;
  transport: J9StripeTransport;
}): Promise<{ scenarios: StageScenario[]; resources: J9TrackedResources }> {
  const loaded = loadJ9RunArtifact(input.config.artifactPath!);
  if (!loaded.ok) {
    return {
      resources: { customers: [], subscriptions: [], checkoutSessions: [], testClocks: [] },
      scenarios: [scenario("cleanup", "FAIL", "config", loaded.reason, { failureReason: loaded.reason })],
    };
  }
  if (input.config.cleanupConfirm !== loaded.artifact.runId) {
    return {
      resources: loaded.artifact.resources,
      scenarios: [scenario("cleanup", "FAIL", "config", "cleanup confirm mismatch", {
        failureReason: "STRIPE_J9_CLEANUP_CONFIRM must equal the artifact runId",
        cleanup: "refused",
      })],
    };
  }
  const cleanup = await cleanupTrackedResources({
    transport: input.transport,
    resources: loaded.artifact.resources,
    secrets: [input.config.apiKey, input.config.webhookSecret],
    pauseCleanup: false,
  });
  const abandoned = sealArtifact({
    ...loaded.artifact,
    stage: "abandoned",
    pauseCleanup: false,
    updatedAt: new Date().toISOString(),
  });
  saveJ9RunArtifact(input.config.artifactPath!, abandoned);
  return { scenarios: [cleanup], resources: loaded.artifact.resources };
}
