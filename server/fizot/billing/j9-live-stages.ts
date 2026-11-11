/**
 * Live J9 prepare / resume / abandoned-cleanup stages. Manual hosted Checkout
 * remains required; incomplete Sessions stay BLOCKED.
 */
import type { J9Config } from "./j9-config.ts";
import { redactSecrets } from "./j9-config.ts";
import {
  assertCompletedCheckoutSession,
  assertCustomerBelongsToRun,
  assertSubscriptionPrice,
} from "./j9-checkout-evidence.ts";
import {
  appendTransition,
  assertOwnedResource,
  createRunId,
  emptyTrackedResources,
  loadJ9RunArtifact,
  saveJ9RunArtifact,
  sealArtifact,
  type J9RunArtifact,
  type J9RunStage,
  type J9TrackedResources,
} from "./j9-run-artifact.ts";
import {
  advanceTestClockUntilReady,
  correlateCustomerEvents,
  createTestClock,
  listStripeEventsPaged,
  nextBillingFrozenTime,
  recurringIntervalFromPrice,
  retrieveTestClock,
} from "./j9-test-clock.ts";
import { invoiceIdFromSubscription, assertPaidInvoice } from "./j9-invoice.ts";
import type { J9StripeTransport } from "./j9-transport.ts";
import { loadWebhookCapture, verifyWebhookCapture } from "./j9-webhook-capture.ts";
import { classifyCleanupError, type CleanupResource } from "./j9-errors.ts";

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

function emptyResources(): J9TrackedResources {
  return emptyTrackedResources();
}

async function verifyLiveOwnership(
  transport: J9StripeTransport,
  artifact: J9RunArtifact,
  resource: CleanupResource,
  id: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Artifact membership alone never authorizes deletion — live Stripe association is required.
  const owned = assertOwnedResource(
    artifact,
    resource === "checkout_session"
      ? "checkoutSessions"
      : resource === "test_clock"
        ? "testClocks"
        : resource === "subscription"
          ? "subscriptions"
          : "customers",
    id,
  );
  if (!owned.ok) return owned;
  try {
    if (resource === "customer") {
      const customer = await transport.request("GET", `customers/${id}`, null);
      return assertCustomerBelongsToRun(customer, { customerId: id, runId: artifact.runId });
    }
    if (resource === "subscription") {
      const sub = await transport.request("GET", `subscriptions/${id}`, null);
      const customerId = typeof sub.customer === "string" ? sub.customer : "";
      if (!customerId || !artifact.resources.customers.includes(customerId)) {
        return { ok: false, reason: "subscription_customer_not_tracked" };
      }
      const metadata = sub.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.fizot_j9_run_id !== "string") {
        return { ok: false, reason: "subscription_run_metadata_missing" };
      }
      if (metadata.fizot_j9_run_id !== artifact.runId) {
        return { ok: false, reason: "subscription_run_metadata_mismatch" };
      }
      if (sub.livemode !== false) return { ok: false, reason: "subscription_livemode_invalid" };
      return { ok: true };
    }
    if (resource === "checkout_session") {
      const session = await transport.request("GET", `checkout/sessions/${id}`, null);
      if (session.livemode !== false) return { ok: false, reason: "session_livemode_invalid" };
      const customerId = typeof session.customer === "string" ? session.customer : "";
      if (!customerId || customerId !== artifact.checkout.customerId) {
        return { ok: false, reason: "session_customer_mismatch" };
      }
      if (!artifact.resources.customers.includes(customerId)) {
        return { ok: false, reason: "session_customer_untracked" };
      }
      const metadata = session.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.fizot_j9_run_id !== "string") {
        return { ok: false, reason: "session_run_metadata_missing" };
      }
      if (metadata.fizot_j9_run_id !== artifact.runId) {
        return { ok: false, reason: "session_run_metadata_mismatch" };
      }
      if (session.subscription != null) {
        const subId = typeof session.subscription === "string" ? session.subscription : null;
        if (!subId || !artifact.resources.subscriptions.includes(subId)) {
          // Open sessions may lack a subscription; completed ones must be tracked.
          if (session.status === "complete") {
            return { ok: false, reason: "session_subscription_untracked" };
          }
        }
      }
      return { ok: true };
    }
    if (resource === "test_clock") {
      if (id !== artifact.clock.clockId) {
        return { ok: false, reason: "clock_id_not_artifact_clock" };
      }
      const clock = await retrieveTestClock(transport, id);
      if (!clock.ok) return { ok: false, reason: clock.reason };
      if (clock.clock.livemode !== false) return { ok: false, reason: "clock_livemode_invalid" };
      const clockCustomerId = artifact.clock.customerId;
      if (!clockCustomerId.startsWith("cus_") || clockCustomerId === "cus_missing") {
        return { ok: false, reason: "clock_customer_missing" };
      }
      const customer = await transport.request("GET", `customers/${clockCustomerId}`, null);
      const customerOk = assertCustomerBelongsToRun(customer, {
        customerId: clockCustomerId,
        runId: artifact.runId,
      });
      if (!customerOk.ok) return customerOk;
      if (customer.test_clock !== id) {
        return { ok: false, reason: "clock_customer_not_attached" };
      }
      return { ok: true };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 80) : "ownership_verify_failed" };
  }
  return { ok: false, reason: "ownership_unhandled" };
}

export function persistRetainedLifecycle(input: {
  hmacSecret: string;
  artifactPath: string;
  artifact: J9RunArtifact;
  to: Extract<J9RunStage, "awaiting_evidence" | "retryable_failure" | "cleanup_partial">;
  reason: string;
  resources?: J9TrackedResources;
}): J9RunArtifact {
  const next = appendTransition(input.hmacSecret, input.artifact, input.to, input.reason, {
    pauseCleanup: true,
    retrySafe: input.to !== "cleanup_partial" ? true : input.artifact.retrySafe,
    resources: input.resources ?? input.artifact.resources,
  });
  saveJ9RunArtifact(input.artifactPath, next);
  return next;
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
  const workspaceId = `ws_j9_${runId.slice(6, 18)}`;
  const frozenTime = input.frozenTime ?? Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const createdAt = new Date().toISOString();
  const resources = emptyResources();

  scenarios.push(scenario(
    "secure_startup",
    "PASS",
    "config",
    `kind=live_j9 stage=prepare mode=test transport=live run=${runId}`,
  ));

  const persistPartial = (stage: Extract<J9RunStage, "cleanup_partial">) => {
    // Retain recorded resources for explicit cleanup; never auto-abandon mid-prepare.
    const at = new Date().toISOString();
    const artifact = sealArtifact(input.config.artifactHmacSecret, {
      schemaVersion: 3,
      kind: "live_j9_run",
      runId,
      stage,
      createdAt,
      workspaceId,
      priceHome: input.config.priceHome,
      priceTeam: input.config.priceTeam,
      pauseCleanup: true,
      retrySafe: false,
      checkout: {
        customerId: resources.customers.find((id) => id) ?? "cus_missing",
        sessionId: resources.checkoutSessions[0] ?? "cs_missing",
        expectedPriceId: input.config.priceHome,
        subscriptionId: null,
      },
      clock: {
        clockId: resources.testClocks[0] ?? "clock_missing",
        frozenTime,
        customerId: resources.customers[1] ?? resources.customers[0] ?? "cus_missing",
        subscriptionId: resources.subscriptions[0] ?? null,
        baselineInvoiceId: null,
        baselineEventIds: [],
      },
      resources: {
        customers: [...resources.customers],
        subscriptions: [...resources.subscriptions],
        checkoutSessions: [...resources.checkoutSessions],
        testClocks: [...resources.testClocks],
      },
      transitions: [{ at, from: "none", to: stage, reason: "prepare_partial_failure" }],
    });
    saveJ9RunArtifact(input.config.artifactPath, artifact);
    return artifact;
  };

  try {
    const clockCreated = await createTestClock(input.transport, {
      frozenTime,
      name: `fizot-j9-${runId}`.slice(0, 300),
    });
    if (!clockCreated.ok) {
      scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", clockCreated.reason, {
        failureReason: clockCreated.reason,
      }));
      const artifact = persistPartial("cleanup_partial");
      return { artifact, checkoutUrl: null, scenarios, resources };
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
      const artifact = persistPartial("cleanup_partial");
      return { artifact, checkoutUrl: null, scenarios, resources };
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
      const artifact = persistPartial("cleanup_partial");
      return { artifact, checkoutUrl: null, scenarios, resources };
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
    if (clockSubId.startsWith("sub_")) resources.subscriptions.push(clockSubId);
    if (!clockSubId.startsWith("sub_") || !baselineInvoiceId) {
      scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "clock baseline subscription missing", {
        failureReason: "clock subscription/invoice missing",
      }));
      const artifact = persistPartial("cleanup_partial");
      return { artifact, checkoutUrl: null, scenarios, resources };
    }
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
      const artifact = persistPartial("cleanup_partial");
      return { artifact, checkoutUrl: null, scenarios, resources };
    }

    const baselineEvents = await listStripeEventsPaged({
      transport: input.transport,
      type: "invoice.paid",
      maxPages: 2,
    });
    const baselineEventIds = baselineEvents.ok
      ? baselineEvents.events
        .filter((event) => {
          const obj = event.data.object;
          return obj.subscription === clockSubId || obj.id === baselineInvoiceId;
        })
        .map((event) => event.id)
      : [];

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
    if (sessionId.startsWith("cs_")) resources.checkoutSessions.push(sessionId);
    if (!sessionId.startsWith("cs_") || !checkoutUrl) {
      scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "checkout session incomplete", {
        failureReason: "missing id or url",
      }));
      const artifact = persistPartial("cleanup_partial");
      return { artifact, checkoutUrl: null, scenarios, resources };
    }

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

    const at = new Date().toISOString();
    const artifact = sealArtifact(input.config.artifactHmacSecret, {
      schemaVersion: 3,
      kind: "live_j9_run",
      runId,
      stage: "awaiting_checkout",
      createdAt,
      workspaceId,
      priceHome: input.config.priceHome,
      priceTeam: input.config.priceTeam,
      pauseCleanup: true,
      retrySafe: true,
      checkout: {
        customerId: checkoutCustomerId,
        sessionId,
        expectedPriceId: input.config.priceHome,
        subscriptionId: null,
      },
      clock: {
        clockId: clockCreated.clock.id,
        frozenTime: clockCreated.clock.frozen_time,
        customerId: clockCustomerId,
        subscriptionId: clockSubId,
        baselineInvoiceId,
        baselineEventIds,
      },
      resources: {
        customers: [...resources.customers],
        subscriptions: [...resources.subscriptions],
        checkoutSessions: [...resources.checkoutSessions],
        testClocks: [...resources.testClocks],
      },
      transitions: [{ at, from: "none", to: "awaiting_checkout", reason: "prepare_open_checkout" }],
    });
    saveJ9RunArtifact(input.config.artifactPath, artifact);
    return { artifact, checkoutUrl, scenarios, resources };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error);
    scenarios.push(scenario("checkout_session_created", "FAIL", "stripe_api", "prepare_aborted", {
      failureReason: message,
    }));
    const artifact = persistPartial("cleanup_partial");
    return { artifact, checkoutUrl: null, scenarios, resources };
  }
}

export type ResumeEvidence = {
  scenarios: StageScenario[];
  resources: J9TrackedResources;
  artifact: J9RunArtifact;
  checkoutSubscriptionId: string;
  checkoutInvoiceId: string;
  webhookCaptureOk: boolean;
};

export async function resumeLiveCheckoutEvidence(input: {
  config: J9Config;
  transport: J9StripeTransport;
}): Promise<
  | { ok: true; evidence: ResumeEvidence }
  | { ok: false; reason: string; scenarios: StageScenario[]; artifact: J9RunArtifact | null; resources: J9TrackedResources }
> {
  const loaded = loadJ9RunArtifact(input.config.artifactPath, input.config.artifactHmacSecret);
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.reason,
      artifact: null,
      resources: emptyResources(),
      scenarios: [scenario("secure_startup", "FAIL", "config", loaded.reason, { failureReason: loaded.reason })],
    };
  }
  const artifact = loaded.artifact;
  if (artifact.priceHome !== input.config.priceHome || artifact.priceTeam !== input.config.priceTeam) {
    return {
      ok: false,
      reason: "artifact_price_mismatch",
      artifact,
      resources: artifact.resources,
      scenarios: [scenario("secure_startup", "FAIL", "config", "artifact prices do not match env", {
        failureReason: "artifact_price_mismatch",
      })],
    };
  }
  if (artifact.stage === "completed" || artifact.stage === "abandoned") {
    return {
      ok: false,
      reason: "artifact_already_terminal",
      artifact,
      resources: artifact.resources,
      scenarios: [scenario("secure_startup", "FAIL", "config", "refuse resume of completed/abandoned run", {
        failureReason: "artifact_already_terminal",
      })],
    };
  }
  if (artifact.stage === "cleanup_partial" && !artifact.retrySafe) {
    return {
      ok: false,
      reason: "artifact_not_retry_safe",
      artifact,
      resources: artifact.resources,
      scenarios: [scenario("secure_startup", "FAIL", "config", "run is not retry-safe; use confirmed cleanup", {
        failureReason: "artifact_not_retry_safe",
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
      artifact,
      resources: artifact.resources,
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
      artifact,
      resources: artifact.resources,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_session_created", "PASS", "stripe_api", `session=${artifact.checkout.sessionId} from_artifact`),
        scenario("checkout_completed", completed.blocked ? "BLOCKED" : "FAIL", "stripe_api", completed.reason, {
          failureReason: completed.reason,
        }),
      ],
    };
  }

  const subscription = await input.transport.request("GET", `subscriptions/${completed.subscriptionId}`, {
    "expand[]": "latest_invoice",
  });
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
      artifact,
      resources: artifact.resources,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_completed", "FAIL", "stripe_api", subOk.reason, { failureReason: subOk.reason }),
      ],
    };
  }

  const invoiceId = invoiceIdFromSubscription(subscription);
  if (!invoiceId) {
    return {
      ok: false,
      reason: "checkout_invoice_missing",
      artifact,
      resources: artifact.resources,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_completed", "FAIL", "stripe_api", "checkout subscription latest_invoice missing", {
          failureReason: "checkout_invoice_missing",
        }),
      ],
    };
  }
  let invoice: Record<string, unknown>;
  if (subscription.latest_invoice && typeof subscription.latest_invoice === "object") {
    invoice = subscription.latest_invoice as Record<string, unknown>;
  } else {
    invoice = await input.transport.request("GET", `invoices/${invoiceId}`, null);
  }
  const paid = assertPaidInvoice(invoice, {
    customerId: completed.customerId,
    subscriptionId: completed.subscriptionId,
  });
  if (!paid.ok) {
    return {
      ok: false,
      reason: paid.reason,
      artifact,
      resources: artifact.resources,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `resume run=${artifact.runId}`),
        scenario("checkout_completed", "FAIL", "stripe_api", paid.reason, { failureReason: paid.reason }),
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
  const captureLoaded = loadWebhookCapture(input.config.webhookCapturePath);
  if (!captureLoaded.ok) {
    webhookScenarios.push(scenario("webhook_lifecycle", "BLOCKED", "none", captureLoaded.reason, {
      failureReason: "Place a Stripe CLI signed capture at artifacts/j9/webhook-capture.json for this runId",
    }));
  } else {
    const verified = await verifyWebhookCapture({
      capture: captureLoaded.capture,
      expectedRunId: artifact.runId,
      expectedCustomerId: completed.customerId,
      expectedSubscriptionId: completed.subscriptionId,
      expectedSessionId: completed.sessionId,
      webhookSecret: input.config.webhookSecret,
      transport: input.transport,
    });
    if (!verified.ok) {
      webhookScenarios.push(scenario(
        "webhook_lifecycle",
        verified.blocked ? "BLOCKED" : "FAIL",
        "stripe_cli_capture",
        `${verified.reason}; signature=${verified.checks.signatureVerified} stripe_origin=${verified.checks.stripeOriginVerified} provenance_claim_only=true`,
        { failureReason: verified.reason },
      ));
    } else {
      webhookCaptureOk = true;
      webhookScenarios.push(scenario(
        "webhook_lifecycle",
        "PASS",
        "stripe_cli_capture",
        `signed_deliveries=${verified.accepted.length} coverage=${verified.coverage.join(",")} run=${artifact.runId} signature=true stripe_origin=true provenance_claim_only=true`,
      ));
    }
  }

  // Persist Checkout subscription linkage immediately so a blocked later stage still
  // uploads the latest artifact (never silently fall back to an older prepare file).
  const updated = appendTransition(
    input.config.artifactHmacSecret,
    artifact,
    webhookCaptureOk ? "awaiting_evidence" : "awaiting_evidence",
    webhookCaptureOk ? "checkout_complete_continue_evidence" : "checkout_complete_awaiting_webhook_or_dunning",
    {
      pauseCleanup: true,
      retrySafe: true,
      checkout: {
        ...artifact.checkout,
        subscriptionId: completed.subscriptionId,
      },
      resources,
    },
  );
  saveJ9RunArtifact(input.config.artifactPath, updated);

  return {
    ok: true,
    evidence: {
      scenarios: [
        scenario("secure_startup", "PASS", "config", `kind=live_j9 stage=resume run=${artifact.runId} retry_safe=${updated.retrySafe}`),
        scenario("checkout_session_created", "PASS", "stripe_api", `session=${artifact.checkout.sessionId} resumed`),
        scenario(
          "checkout_completed",
          "PASS",
          "stripe_api",
          `session=${completed.sessionId} status=complete payment_status=paid subscription=${completed.subscriptionId} invoice=${paid.invoiceId}`,
        ),
        ...webhookScenarios,
      ],
      resources,
      artifact: updated,
      checkoutSubscriptionId: completed.subscriptionId,
      checkoutInvoiceId: paid.invoiceId,
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
  const baselineInvoiceId = input.artifact.clock.baselineInvoiceId;
  if (!subscriptionId || !baselineInvoiceId) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "clock baseline missing", {
      failureReason: "prepare did not record clock subscription/baseline invoice",
    });
  }

  const retrieved = await retrieveTestClock(input.transport, clockId);
  if (!retrieved.ok) {
    return scenario("stripe_dunning_recovery", "FAIL", "stripe_api", retrieved.reason, { failureReason: retrieved.reason });
  }
  if (retrieved.clock.status === "internal_failure") {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "test_clock_internal_failure", {
      failureReason: "Stripe test clock entered internal_failure",
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

  const preFailureFrozen = retrieved.clock.frozen_time;
  await input.transport.request("POST", "payment_methods/pm_card_chargeCustomerFail/attach", { customer: customerId });
  await input.transport.request("POST", `customers/${customerId}`, {
    "invoice_settings[default_payment_method]": "pm_card_chargeCustomerFail",
  });

  const target = nextBillingFrozenTime(preFailureFrozen, recurring);
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

  const failedList = await listStripeEventsPaged({ transport: input.transport, type: "invoice.payment_failed" });
  if (!failedList.ok) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", failedList.reason, {
      failureReason: failedList.reason,
    });
  }
  if (failedList.truncated) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "events_list_truncated", {
      failureReason: "Stripe Events pagination truncated; cannot honestly confirm failure evidence",
    });
  }
  const failedMatch = correlateCustomerEvents(failedList.events, {
    customerId,
    subscriptionId,
    types: ["invoice.payment_failed"],
    excludeEventIds: input.artifact.clock.baselineEventIds,
    excludeInvoiceIds: [baselineInvoiceId],
    createdAfterSec: preFailureFrozen,
  });
  if (failedMatch.missingTypes.length > 0 || failedMatch.matched.length < 1) {
    return scenario(
      "stripe_dunning_recovery",
      "BLOCKED",
      "stripe_api",
      `clock=${clockId} missing=invoice.payment_failed rejected=${failedMatch.rejected.length}`,
      {
        failureReason: "Absent post-baseline Stripe-generated payment failure for the clock subscription",
      },
    );
  }
  const failureEvent = failedMatch.matched[0]!;
  const failureInvoiceId = typeof failureEvent.data.object.id === "string" ? failureEvent.data.object.id : null;
  if (!failureInvoiceId || failureInvoiceId === baselineInvoiceId) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "failure invoice not distinct from baseline", {
      failureReason: "payment_failed must reference a post-baseline invoice",
    });
  }

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

  const paidList = await listStripeEventsPaged({ transport: input.transport, type: "invoice.paid" });
  if (!paidList.ok) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", paidList.reason, {
      failureReason: paidList.reason,
    });
  }
  if (paidList.truncated) {
    return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", "events_list_truncated", {
      failureReason: "Stripe Events pagination truncated; cannot honestly confirm recovery evidence",
    });
  }
  const paidMatch = correlateCustomerEvents(paidList.events, {
    customerId,
    subscriptionId,
    types: ["invoice.paid"],
    excludeEventIds: [...input.artifact.clock.baselineEventIds, failureEvent.id],
    excludeInvoiceIds: [baselineInvoiceId, failureInvoiceId],
    createdAfterSec: failureEvent.created,
  });
  if (paidMatch.matched.length < 1) {
    // Also accept recovered subscription status from Stripe if a distinct paid invoice exists on the subscription.
    const refreshed = await input.transport.request("GET", `subscriptions/${subscriptionId}`, {
      "expand[]": "latest_invoice",
    });
    const latestId = invoiceIdFromSubscription(refreshed);
    if (!latestId || latestId === baselineInvoiceId || latestId === failureInvoiceId || refreshed.status !== "active") {
      return scenario(
        "stripe_dunning_recovery",
        "BLOCKED",
        "stripe_api",
        `clock=${clockId} recovery_not_confirmed`,
        { failureReason: "Recovery not confirmed by a post-failure invoice.paid distinct from baseline" },
      );
    }
    let latestInvoice: Record<string, unknown>;
    if (refreshed.latest_invoice && typeof refreshed.latest_invoice === "object") {
      latestInvoice = refreshed.latest_invoice as Record<string, unknown>;
    } else {
      latestInvoice = await input.transport.request("GET", `invoices/${latestId}`, null);
    }
    const recoveryPaid = assertPaidInvoice(latestInvoice, { customerId, subscriptionId });
    if (!recoveryPaid.ok) {
      return scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", recoveryPaid.reason, {
        failureReason: recoveryPaid.reason,
      });
    }
  }

  return scenario(
    "stripe_dunning_recovery",
    "PASS",
    "stripe_api",
    `clock=${clockId} stripe_time=${recoveredClock.clock.frozen_time} failed_invoice=${failureInvoiceId} baseline_excluded=true label=stripe_test_clock_not_app_worker_clock`,
  );
}

export async function cleanupTrackedResources(input: {
  transport: J9StripeTransport;
  resources: J9TrackedResources;
  secrets: string[];
  pauseCleanup?: boolean;
  artifact?: J9RunArtifact | null;
  hmacSecret?: string;
  artifactPath?: string;
  /** After full verification PASS, mark stage completed instead of abandoned. */
  markCompleted?: boolean;
  retainReason?: string;
}): Promise<StageScenario> {
  if (input.pauseCleanup) {
    return scenario(
      "cleanup",
      "BLOCKED",
      "stripe_api",
      input.retainReason ?? "pauseCleanup=true resources_retained",
      {
        failureReason: "Resources retained for retry or manual Checkout; run stage=cleanup with STRIPE_J9_CLEANUP_CONFIRM=<runId> when ready",
        cleanup: "retained",
      },
    );
  }
  if (input.artifact) {
    // Refuse cleanup when sealed ownership cannot be established.
    if (!input.hmacSecret) {
      return scenario("cleanup", "FAIL", "config", "artifact_hmac_missing_for_cleanup", {
        failureReason: "Cannot delete without verifying artifact MAC ownership",
        cleanup: "refused",
      });
    }
  }
  const remaining: string[] = [];
  const recordFailure = (resource: CleanupResource, id: string, error: unknown) => {
    const classified = classifyCleanupError(resource, error);
    if (classified.action === "tolerate") return;
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), input.secrets).slice(0, 80);
    remaining.push(`${resource}:${id}:${classified.reason}:${detail}`);
  };

  // Pre-verify every resource before any destructive call so later deletes cannot
  // invalidate earlier ownership evidence (e.g. clock customer lookup after customer delete).
  const authorized = {
    checkoutSessions: [] as string[],
    subscriptions: [] as string[],
    customers: [] as string[],
    testClocks: [] as string[],
  };
  if (input.artifact) {
    for (const sessionId of input.resources.checkoutSessions) {
      const ownership = await verifyLiveOwnership(input.transport, input.artifact, "checkout_session", sessionId);
      if (!ownership.ok) remaining.push(`checkout_session:${sessionId}:ownership:${ownership.reason}`);
      else authorized.checkoutSessions.push(sessionId);
    }
    for (const sub of input.resources.subscriptions) {
      const ownership = await verifyLiveOwnership(input.transport, input.artifact, "subscription", sub);
      if (!ownership.ok) remaining.push(`subscription:${sub}:ownership:${ownership.reason}`);
      else authorized.subscriptions.push(sub);
    }
    for (const customer of input.resources.customers) {
      const ownership = await verifyLiveOwnership(input.transport, input.artifact, "customer", customer);
      if (!ownership.ok) remaining.push(`customer:${customer}:ownership:${ownership.reason}`);
      else authorized.customers.push(customer);
    }
    for (const clockId of input.resources.testClocks) {
      const ownership = await verifyLiveOwnership(input.transport, input.artifact, "test_clock", clockId);
      if (!ownership.ok) remaining.push(`test_clock:${clockId}:ownership:${ownership.reason}`);
      else authorized.testClocks.push(clockId);
    }
    if (remaining.length > 0) {
      if (input.hmacSecret && input.artifactPath) {
        const partial = appendTransition(
          input.hmacSecret,
          input.artifact,
          "cleanup_partial",
          `cleanup_ownership_refused=${remaining.length}`,
          { pauseCleanup: false, retrySafe: false },
        );
        saveJ9RunArtifact(input.artifactPath, partial);
      }
      return scenario("cleanup", "FAIL", "stripe_api", `remaining=${remaining.length}`, {
        failureReason: `${remaining.join("; ")}; refused destructive action for unprovable ownership; retry stage=cleanup with STRIPE_J9_CLEANUP_CONFIRM=<runId>`,
        cleanup: "partial",
      });
    }
  } else {
    authorized.checkoutSessions = [...input.resources.checkoutSessions];
    authorized.subscriptions = [...input.resources.subscriptions];
    authorized.customers = [...input.resources.customers];
    authorized.testClocks = [...input.resources.testClocks];
  }

  for (const sessionId of [...authorized.checkoutSessions].reverse()) {
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
  for (const sub of [...authorized.subscriptions].reverse()) {
    try {
      await input.transport.request("DELETE", `subscriptions/${sub}`, { invoice_now: "false", prorate: "true" });
    } catch (error) {
      recordFailure("subscription", sub, error);
    }
  }
  // Delete Test Clocks before customers: Stripe clocks own attached customers.
  for (const clockId of [...authorized.testClocks].reverse()) {
    try {
      await input.transport.request("DELETE", `test_helpers/test_clocks/${clockId}`, null);
    } catch (error) {
      recordFailure("test_clock", clockId, error);
    }
  }
  for (const customer of [...authorized.customers].reverse()) {
    try {
      await input.transport.request("DELETE", `customers/${customer}`, null);
    } catch (error) {
      recordFailure("customer", customer, error);
    }
  }
  if (remaining.length > 0) {
    if (input.artifact && input.hmacSecret && input.artifactPath) {
      const partial = appendTransition(
        input.hmacSecret,
        input.artifact,
        "cleanup_partial",
        `cleanup_remaining=${remaining.length}`,
        {
          pauseCleanup: false,
          retrySafe: false,
        },
      );
      saveJ9RunArtifact(input.artifactPath, partial);
    }
    return scenario("cleanup", "FAIL", "stripe_api", `remaining=${remaining.length}`, {
      failureReason: `${remaining.join("; ")}; manual cleanup may be required for ownership-refused ids; retry stage=cleanup with STRIPE_J9_CLEANUP_CONFIRM=<runId>`,
      cleanup: "partial",
    });
  }
  if (input.artifact && input.hmacSecret && input.artifactPath) {
    const terminalStage: J9RunStage = input.markCompleted ? "completed" : "abandoned";
    const done = appendTransition(
      input.hmacSecret,
      input.artifact,
      terminalStage,
      input.markCompleted ? "auto_cleanup_after_full_verification" : "confirmed_abandoned_cleanup",
      {
        pauseCleanup: false,
        retrySafe: false,
        checkout: {
          customerId: "cus_missing",
          sessionId: "cs_missing",
          expectedPriceId: input.artifact.priceHome,
          subscriptionId: null,
        },
        clock: {
          clockId: "clock_missing",
          frozenTime: input.artifact.clock.frozenTime,
          customerId: "cus_missing",
          subscriptionId: null,
          baselineInvoiceId: null,
          baselineEventIds: [],
        },
        resources: emptyResources(),
      },
    );
    saveJ9RunArtifact(input.artifactPath, done);
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
}): Promise<{ scenarios: StageScenario[]; resources: J9TrackedResources; artifact: J9RunArtifact | null }> {
  // Expired artifacts may still strand resources; allow MAC-verified expired load for confirmed cleanup only.
  const loaded = loadJ9RunArtifact(input.config.artifactPath, input.config.artifactHmacSecret, Date.now(), {
    allowExpired: true,
  });
  if (!loaded.ok) {
    return {
      artifact: null,
      resources: emptyResources(),
      scenarios: [scenario("cleanup", "FAIL", "config", loaded.reason, {
        failureReason: loaded.reason,
        cleanup: "refused",
      })],
    };
  }
  if (input.config.cleanupConfirm !== loaded.artifact.runId) {
    return {
      artifact: loaded.artifact,
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
    secrets: [input.config.apiKey, input.config.webhookSecret, input.config.artifactHmacSecret],
    pauseCleanup: false,
    artifact: loaded.artifact,
    hmacSecret: input.config.artifactHmacSecret,
    artifactPath: input.config.artifactPath,
    markCompleted: false,
  });
  return { scenarios: [cleanup], resources: loaded.artifact.resources, artifact: loaded.artifact };
}
