/**
 * J9 live resource ownership checks and confirmed/auto cleanup.
 * Artifact membership alone never authorizes deletion.
 */
import type { J9Config } from "./j9-config.ts";
import { redactSecrets } from "./j9-config.ts";
import { assertCustomerBelongsToRun } from "./j9-checkout-evidence.ts";
import {
  appendTransition,
  assertOwnedResource,
  emptyTrackedResources,
  loadJ9RunArtifact,
  saveJ9RunArtifact,
  type J9RunArtifact,
  type J9RunStage,
  type J9TrackedResources,
} from "./j9-run-artifact.ts";
import { retrieveTestClock } from "./j9-test-clock.ts";
import type { J9StripeTransport } from "./j9-transport.ts";
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

async function verifyLiveOwnership(
  transport: J9StripeTransport,
  artifact: J9RunArtifact,
  resource: CleanupResource,
  id: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
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

export async function cleanupTrackedResources(input: {
  transport: J9StripeTransport;
  resources: J9TrackedResources;
  secrets: string[];
  pauseCleanup?: boolean;
  artifact?: J9RunArtifact | null;
  hmacSecret?: string;
  artifactPath?: string;
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
  if (input.artifact && !input.hmacSecret) {
    return scenario("cleanup", "FAIL", "config", "artifact_hmac_missing_for_cleanup", {
      failureReason: "Cannot delete without verifying artifact MAC ownership",
      cleanup: "refused",
    });
  }
  const remaining: string[] = [];
  const recordFailure = (resource: CleanupResource, id: string, error: unknown) => {
    const classified = classifyCleanupError(resource, error);
    if (classified.action === "tolerate") return;
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), input.secrets).slice(0, 80);
    remaining.push(`${resource}:${id}:${classified.reason}:${detail}`);
  };

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
        { pauseCleanup: false, retrySafe: false },
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
        resources: emptyTrackedResources(),
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
  const loaded = loadJ9RunArtifact(input.config.artifactPath, input.config.artifactHmacSecret, Date.now(), {
    allowExpired: true,
  });
  if (!loaded.ok) {
    return {
      artifact: null,
      resources: emptyTrackedResources(),
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
