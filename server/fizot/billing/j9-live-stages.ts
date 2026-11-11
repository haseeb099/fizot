/**
 * Live J9 prepare / resume / Test Clock dunning stages. Manual hosted Checkout
 * remains required; incomplete Sessions stay BLOCKED.
 */
import type { J9Config } from "./j9-config.ts";
import {
  assertCompletedCheckoutSession,
  assertCustomerBelongsToRun,
  assertSubscriptionPrice,
} from "./j9-checkout-evidence.ts";
import {
  appendTransition,
  createRunId,
  emptyDunningCheckpoint,
  emptyTrackedResources,
  loadJ9RunArtifact,
  persistArtifactUpdate,
  saveJ9RunArtifact,
  sealArtifact,
  type J9DunningCheckpoint,
  type J9RunArtifact,
  type J9RunStage,
  type J9TrackedResources,
} from "./j9-run-artifact.ts";
import {
  correlateCustomerEvents,
  createTestClock,
  ensureTestClockFrozenAt,
  listStripeEventsPaged,
  nextBillingFrozenTime,
  recurringIntervalFromPrice,
  retrieveTestClock,
} from "./j9-test-clock.ts";
import { invoiceIdFromSubscription, assertPaidInvoice } from "./j9-invoice.ts";
import type { J9StripeTransport } from "./j9-transport.ts";
import { loadWebhookCapture, verifyWebhookCapture } from "./j9-webhook-capture.ts";
import {
  cleanupAbandonedRun,
  cleanupTrackedResources,
  persistRetainedLifecycle,
  type StageScenario,
} from "./j9-cleanup.ts";

export type { StageScenario };
export { cleanupAbandonedRun, cleanupTrackedResources, persistRetainedLifecycle };

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
      schemaVersion: 4,
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
        creditInvoiceId: null,
      },
      clock: {
        clockId: resources.testClocks[0] ?? "clock_missing",
        frozenTime,
        customerId: resources.customers[1] ?? resources.customers[0] ?? "cus_missing",
        subscriptionId: resources.subscriptions[0] ?? null,
        baselineInvoiceId: null,
        baselineEventIds: [],
        dunning: emptyDunningCheckpoint(),
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
      schemaVersion: 4,
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
        creditInvoiceId: null,
      },
      clock: {
        clockId: clockCreated.clock.id,
        frozenTime: clockCreated.clock.frozen_time,
        customerId: clockCustomerId,
        subscriptionId: clockSubId,
        baselineInvoiceId,
        baselineEventIds,
        dunning: emptyDunningCheckpoint(),
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

export type DunningRunResult = {
  scenario: StageScenario;
  artifact: J9RunArtifact;
};

function withDunning(
  artifact: J9RunArtifact,
  dunning: J9DunningCheckpoint,
  frozenTime?: number,
): J9RunArtifact["clock"] {
  return {
    ...artifact.clock,
    frozenTime: frozenTime ?? artifact.clock.frozenTime,
    dunning,
  };
}

/**
 * Stripe Test Clock failure→recovery with authenticated checkpoints.
 * Reconciles live frozen_time/events before any irreversible advance.
 */
export async function runStripeTestClockDunning(input: {
  transport: J9StripeTransport;
  artifact: J9RunArtifact;
  hmacSecret: string;
  artifactPath: string;
  sleepMs?: number;
}): Promise<DunningRunResult> {
  let artifact = input.artifact;
  const clockId = artifact.clock.clockId;
  const customerId = artifact.clock.customerId;
  const subscriptionId = artifact.clock.subscriptionId;
  const baselineInvoiceId = artifact.clock.baselineInvoiceId;
  const persist = (dunning: J9DunningCheckpoint, frozenTime?: number) => {
    artifact = persistArtifactUpdate(input.hmacSecret, input.artifactPath, artifact, {
      clock: withDunning(artifact, dunning, frozenTime),
    });
  };
  const blocked = (evidence: string, failureReason: string): DunningRunResult => ({
    artifact,
    scenario: scenario("stripe_dunning_recovery", "BLOCKED", "stripe_api", evidence, { failureReason }),
  });
  const failed = (evidence: string, failureReason: string): DunningRunResult => ({
    artifact,
    scenario: scenario("stripe_dunning_recovery", "FAIL", "stripe_api", evidence, { failureReason }),
  });

  if (!subscriptionId || !baselineInvoiceId) {
    return blocked("clock baseline missing", "prepare did not record clock subscription/baseline invoice");
  }

  const retrieved = await retrieveTestClock(input.transport, clockId);
  if (!retrieved.ok) return failed(retrieved.reason, retrieved.reason);
  if (retrieved.clock.status === "internal_failure") {
    return blocked("test_clock_internal_failure", "Stripe test clock entered internal_failure");
  }

  // Already recovered on a prior resume — do not touch Stripe again.
  if (artifact.clock.dunning.phase === "recovered") {
    if (
      !artifact.clock.dunning.failureInvoiceId
      || artifact.clock.dunning.failureInvoiceId === baselineInvoiceId
      || !artifact.clock.dunning.recoveryInvoiceId
      || artifact.clock.dunning.recoveryInvoiceId === baselineInvoiceId
      || artifact.clock.dunning.recoveryInvoiceId === artifact.clock.dunning.failureInvoiceId
    ) {
      return blocked("recovered_checkpoint_invalid", "Recovered checkpoint missing distinct failure/recovery invoices");
    }
    return {
      artifact,
      scenario: scenario(
        "stripe_dunning_recovery",
        "PASS",
        "stripe_api",
        `clock=${clockId} stripe_time=${retrieved.clock.frozen_time} failed_invoice=${artifact.clock.dunning.failureInvoiceId} recovery_invoice=${artifact.clock.dunning.recoveryInvoiceId} checkpoint=recovered skipped_side_effects=true baseline_excluded=true`,
      ),
    };
  }

  const subscription = await input.transport.request("GET", `subscriptions/${subscriptionId}`, null);
  const price = (subscription.items as { data?: Array<{ price?: Record<string, unknown> }> } | undefined)?.data?.[0]?.price;
  if (!price) {
    return blocked("subscription price missing", "cannot determine recurring interval for clock advance");
  }
  const recurring = recurringIntervalFromPrice(price);
  if (!recurring) {
    return blocked("price not recurring", "Test Clock advance requires a recurring Price");
  }

  const poll = {
    sleepMs: input.sleepMs ?? 0,
    maxAttempts: input.sleepMs && input.sleepMs > 0 ? 40 : 3,
  };
  let dunning: J9DunningCheckpoint = { ...artifact.clock.dunning };
  const baselineFrozen = artifact.clock.frozenTime;

  // First failure target is derived from prepare baseline frozen_time only.
  if (dunning.failTargetFrozenTime == null) {
    dunning = {
      ...dunning,
      failTargetFrozenTime: nextBillingFrozenTime(baselineFrozen, recurring),
    };
    persist(dunning);
  }

  // If Stripe already advanced past the failure target without a checkpoint, adopt that state.
  if (
    retrieved.clock.frozen_time >= (dunning.failTargetFrozenTime ?? Number.POSITIVE_INFINITY)
    && (dunning.phase === "baseline" || dunning.phase === "fail_pm_set" || dunning.phase === "failure_advance_committed")
  ) {
    dunning = { ...dunning, phase: "failure_advanced" };
    persist(dunning, retrieved.clock.frozen_time);
  }

  if (dunning.phase === "baseline") {
    await input.transport.request("POST", "payment_methods/pm_card_chargeCustomerFail/attach", { customer: customerId });
    await input.transport.request("POST", `customers/${customerId}`, {
      "invoice_settings[default_payment_method]": "pm_card_chargeCustomerFail",
    });
    dunning = { ...dunning, phase: "fail_pm_set" };
    persist(dunning);
  }

  if (
    dunning.phase === "fail_pm_set"
    || dunning.phase === "failure_advance_committed"
    || dunning.phase === "failure_advanced"
  ) {
    const failTarget = dunning.failTargetFrozenTime!;
    // Fresh POST only in the same turn that records the committed intent.
    const freshFailureAdvance = dunning.phase === "fail_pm_set";
    if (freshFailureAdvance) {
      dunning = { ...dunning, phase: "failure_advance_committed" };
      persist(dunning);
    }
    const advanced = await ensureTestClockFrozenAt({
      transport: input.transport,
      clockId,
      targetFrozenTime: failTarget,
      allowAdvance: freshFailureAdvance,
      ...poll,
    });
    if (!advanced.ok) {
      const isBlocked = advanced.reason.includes("internal_failure")
        || advanced.reason.includes("timeout")
        || advanced.reason === "advance_outcome_ambiguous";
      return isBlocked ? blocked(advanced.reason, advanced.reason) : failed(advanced.reason, advanced.reason);
    }
    dunning = { ...dunning, phase: "failure_advanced" };
    persist(dunning, advanced.clock.frozen_time);
  }

  if (dunning.phase === "failure_advanced" || dunning.phase === "failure_confirmed") {
    if (!dunning.failureInvoiceId || !dunning.failureEventId) {
      const failedList = await listStripeEventsPaged({ transport: input.transport, type: "invoice.payment_failed" });
      if (!failedList.ok) return blocked(failedList.reason, failedList.reason);
      if (failedList.truncated) {
        return blocked("events_list_truncated", "Stripe Events pagination truncated; cannot honestly confirm failure evidence");
      }
      const failedMatch = correlateCustomerEvents(failedList.events, {
        customerId,
        subscriptionId,
        types: ["invoice.payment_failed"],
        excludeEventIds: artifact.clock.baselineEventIds,
        excludeInvoiceIds: [baselineInvoiceId],
        createdAfterSec: baselineFrozen,
      });
      if (failedMatch.matched.length < 1) {
        return blocked(
          `clock=${clockId} missing=invoice.payment_failed`,
          "Absent post-baseline Stripe-generated payment failure for the clock subscription",
        );
      }
      const failureEvent = failedMatch.matched[0]!;
      const failureInvoiceId = typeof failureEvent.data.object.id === "string" ? failureEvent.data.object.id : null;
      if (!failureInvoiceId || failureInvoiceId === baselineInvoiceId) {
        return blocked("failure invoice not distinct from baseline", "payment_failed must reference a post-baseline invoice");
      }
      dunning = {
        ...dunning,
        phase: "failure_confirmed",
        failureInvoiceId,
        failureEventId: failureEvent.id,
      };
      persist(dunning);
    } else if (dunning.phase === "failure_advanced") {
      dunning = { ...dunning, phase: "failure_confirmed" };
      persist(dunning);
    }
  }

  if (dunning.phase === "failure_confirmed") {
    await input.transport.request("POST", "payment_methods/pm_card_visa/attach", { customer: customerId });
    await input.transport.request("POST", `customers/${customerId}`, {
      "invoice_settings[default_payment_method]": "pm_card_visa",
    });
    const live = await retrieveTestClock(input.transport, clockId);
    if (!live.ok) return failed(live.reason, live.reason);
    dunning = {
      ...dunning,
      phase: "recover_pm_set",
      recoverTargetFrozenTime: dunning.recoverTargetFrozenTime ?? nextBillingFrozenTime(live.clock.frozen_time, recurring),
    };
    persist(dunning, live.clock.frozen_time);
  }

  if (
    dunning.phase === "recover_pm_set"
    || dunning.phase === "recovery_advance_committed"
    || dunning.phase === "recovery_advanced"
  ) {
    const recoverTarget = dunning.recoverTargetFrozenTime;
    if (recoverTarget == null) {
      return blocked("recovery_target_missing", "Cannot establish recovery advance target from checkpoint or Stripe state");
    }
    // Fresh POST only in the same turn that records the committed intent.
    const freshRecoveryAdvance = dunning.phase === "recover_pm_set";
    if (freshRecoveryAdvance) {
      dunning = { ...dunning, phase: "recovery_advance_committed" };
      persist(dunning);
    }
    const recoveredClock = await ensureTestClockFrozenAt({
      transport: input.transport,
      clockId,
      targetFrozenTime: recoverTarget,
      allowAdvance: freshRecoveryAdvance,
      ...poll,
    });
    if (!recoveredClock.ok) {
      return blocked(recoveredClock.reason, `recovery clock advance: ${recoveredClock.reason}`);
    }
    dunning = { ...dunning, phase: "recovery_advanced" };
    persist(dunning, recoveredClock.clock.frozen_time);
  }

  if (dunning.phase === "recovery_advanced" || dunning.phase === "recovered") {
    const failureInvoiceId = dunning.failureInvoiceId;
    const failureEventId = dunning.failureEventId;
    if (!failureInvoiceId || !failureEventId || failureInvoiceId === baselineInvoiceId) {
      return blocked("failure_checkpoint_missing", "Cannot confirm recovery without distinct failure invoice checkpoint");
    }

    let recoveryInvoiceId = dunning.recoveryInvoiceId;
    let recoveryEventId = dunning.recoveryEventId;
    if (!recoveryInvoiceId) {
      const paidList = await listStripeEventsPaged({ transport: input.transport, type: "invoice.paid" });
      if (!paidList.ok) return blocked(paidList.reason, paidList.reason);
      if (paidList.truncated) {
        return blocked("events_list_truncated", "Stripe Events pagination truncated; cannot honestly confirm recovery evidence");
      }
      const paidMatch = correlateCustomerEvents(paidList.events, {
        customerId,
        subscriptionId,
        types: ["invoice.paid"],
        excludeEventIds: [...artifact.clock.baselineEventIds, failureEventId],
        excludeInvoiceIds: [baselineInvoiceId, failureInvoiceId],
        createdAfterSec: dunning.failTargetFrozenTime ?? baselineFrozen,
      });
      if (paidMatch.matched.length >= 1) {
        const recoveryEvent = paidMatch.matched[0]!;
        const invoiceId = typeof recoveryEvent.data.object.id === "string" ? recoveryEvent.data.object.id : null;
        if (!invoiceId || invoiceId === baselineInvoiceId || invoiceId === failureInvoiceId) {
          return blocked("recovery_invoice_not_distinct", "Recovery must not reuse baseline or failure invoice");
        }
        recoveryInvoiceId = invoiceId;
        recoveryEventId = recoveryEvent.id;
      } else {
        const refreshed = await input.transport.request("GET", `subscriptions/${subscriptionId}`, {
          "expand[]": "latest_invoice",
        });
        const latestId = invoiceIdFromSubscription(refreshed);
        if (!latestId || latestId === baselineInvoiceId || latestId === failureInvoiceId || refreshed.status !== "active") {
          return blocked(
            `clock=${clockId} recovery_not_confirmed`,
            "Recovery not confirmed by a post-failure invoice.paid distinct from baseline",
          );
        }
        let latestInvoice: Record<string, unknown>;
        if (refreshed.latest_invoice && typeof refreshed.latest_invoice === "object") {
          latestInvoice = refreshed.latest_invoice as Record<string, unknown>;
        } else {
          latestInvoice = await input.transport.request("GET", `invoices/${latestId}`, null);
        }
        const recoveryPaid = assertPaidInvoice(latestInvoice, { customerId, subscriptionId });
        if (!recoveryPaid.ok) return blocked(recoveryPaid.reason, recoveryPaid.reason);
        recoveryInvoiceId = recoveryPaid.invoiceId;
      }
    }

    dunning = {
      ...dunning,
      phase: "recovered",
      recoveryInvoiceId,
      recoveryEventId: recoveryEventId ?? dunning.recoveryEventId,
    };
    persist(dunning);
  }

  const finalClock = await retrieveTestClock(input.transport, clockId);
  const stripeTime = finalClock.ok ? finalClock.clock.frozen_time : artifact.clock.frozenTime;
  return {
    artifact,
    scenario: scenario(
      "stripe_dunning_recovery",
      "PASS",
      "stripe_api",
      `clock=${clockId} stripe_time=${stripeTime} failed_invoice=${artifact.clock.dunning.failureInvoiceId} recovery_invoice=${artifact.clock.dunning.recoveryInvoiceId} phase=${artifact.clock.dunning.phase} baseline_excluded=true label=stripe_test_clock_not_app_worker_clock`,
    ),
  };
}

