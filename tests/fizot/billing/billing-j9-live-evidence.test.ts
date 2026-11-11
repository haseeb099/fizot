import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signStripeHeader } from "../../../server/fizot/admin/webhooks.ts";
import { runJ9 } from "../../../server/fizot/billing/j9-driver.ts";
import { assertCompletedCheckoutSession } from "../../../server/fizot/billing/j9-checkout-evidence.ts";
import {
  createRunId,
  loadJ9RunArtifact,
  parseJ9RunArtifact,
  sealArtifact,
  J9_FIXED_ARTIFACT_RELATIVE,
  J9_FIXED_CAPTURE_RELATIVE,
} from "../../../server/fizot/billing/j9-run-artifact.ts";
import {
  advanceTestClockUntilReady,
  correlateCustomerEvents,
  parseStripeEvent,
} from "../../../server/fizot/billing/j9-test-clock.ts";
import { createFakeStripeTransport } from "../../../server/fizot/billing/j9-transport.ts";
import { verifyWebhookCapture } from "../../../server/fizot/billing/j9-webhook-capture.ts";

const secret = "whsec_test_j9_live_evidence";
const hmacSecret = "j9_artifact_hmac_secret_for_unit_tests_only_32";

function repoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "j9-repo-"));
  mkdirSync(join(root, "artifacts", "j9"), { recursive: true });
  return root;
}

function liveEnv(root: string, extra: Record<string, string> = {}) {
  return {
    STRIPE_J9_MODE: "test",
    STRIPE_J9_TRANSPORT: "live",
    STRIPE_TEST_API_KEY: "sk_test_FAKE_KEY_DO_NOT_LEAK_OR_PRINT",
    STRIPE_TEST_WEBHOOK_SECRET: secret,
    STRIPE_J9_ARTIFACT_HMAC_SECRET: hmacSecret,
    STRIPE_J9_PRICE_HOME: "price_j9_test_home",
    STRIPE_J9_PRICE_TEAM: "price_j9_test_team",
    ...extra,
  };
}

function artifactFile(root: string): string {
  return join(root, J9_FIXED_ARTIFACT_RELATIVE);
}

function captureFile(root: string): string {
  return join(root, J9_FIXED_CAPTURE_RELATIVE);
}

function writeSignedCapture(path: string, input: {
  runId: string;
  customerId: string;
  subscriptionId: string;
  sessionId: string;
}): void {
  const created = 1_700_000_100;
  const sessionBody = JSON.stringify({
    id: "evt_capture_session",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: {
      object: {
        id: input.sessionId,
        object: "checkout.session",
        customer: input.customerId,
        subscription: input.subscriptionId,
        metadata: { fizot_j9_run_id: input.runId },
      },
    },
  });
  const paidBody = JSON.stringify({
    id: "evt_capture_paid",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: {
      object: {
        id: "in_capture_paid",
        object: "invoice",
        customer: input.customerId,
        subscription: input.subscriptionId,
        metadata: { fizot_j9_run_id: input.runId },
      },
    },
  });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 2,
    kind: "stripe_cli_signed_capture",
    runId: input.runId,
    capturedAt: new Date().toISOString(),
    deliveries: [
      {
        body: sessionBody,
        stripeSignatureHeader: signStripeHeader(secret, sessionBody, created),
        provenance: "stripe_cli_listen",
      },
      {
        body: paidBody,
        stripeSignatureHeader: signStripeHeader(secret, paidBody, created + 1),
        provenance: "stripe_cli_listen",
      },
    ],
  }));
}

it("resumes the same sealed test run after prepare using Checkout subscription credit", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }),
    transport,
    repoRoot: root,
  });
  expect(prepared.overall).toBe("BLOCKED");
  expect(prepared.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");
  const artifact = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;

  transport.markCheckoutComplete(artifact.artifact.checkout.sessionId);
  const session = await transport.request("GET", `checkout/sessions/${artifact.artifact.checkout.sessionId}`, null);
  writeSignedCapture(captureFile(root), {
    runId: artifact.artifact.runId,
    customerId: artifact.artifact.checkout.customerId,
    subscriptionId: String(session.subscription),
    sessionId: artifact.artifact.checkout.sessionId,
  });

  const resumed = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(resumed.scenarios.find((row) => row.scenario === "checkout_completed")?.status).toBe("PASS");
  expect(resumed.scenarios.find((row) => row.scenario === "subscription_payment_and_credit")?.evidence).toContain("source=checkout_session_subscription");
  expect(resumed.scenarios.find((row) => row.scenario === "subscription_payment_and_credit")?.evidence).toContain("separate_api_subscription=false");
  expect(resumed.scenarios.find((row) => row.scenario === "stripe_dunning_recovery")?.status).toBe("PASS");
  expect(resumed.scenarios.find((row) => row.scenario === "stripe_dunning_recovery")?.evidence).toContain("baseline_excluded=true");
});

it("rejects MAC tampering and substituted run payloads", () => {
  const runId = createRunId();
  const sealed = sealArtifact(hmacSecret, {
    schemaVersion: 2,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_j9_test_home",
    priceTeam: "price_j9_test_home",
    pauseCleanup: true,
    checkout: { customerId: "cus_a", sessionId: "cs_a", expectedPriceId: "price_j9_test_home", subscriptionId: null },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: "sub_a",
      baselineInvoiceId: "in_a",
      baselineEventIds: ["evt_base"],
    },
    resources: {
      customers: ["cus_a", "cus_b"],
      subscriptions: ["sub_a"],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
  });
  expect(parseJ9RunArtifact({ ...sealed, artifactMac: "00".repeat(32) }, hmacSecret).ok).toBe(false);
  expect(parseJ9RunArtifact({
    ...sealed,
    runId: createRunId(),
  }, hmacSecret).ok).toBe(false);
  expect(parseJ9RunArtifact({
    ...sealed,
    resources: { ...sealed.resources, customers: ["cus_foreign", "cus_b"] },
  }, hmacSecret).ok).toBe(false);
  // Recalculating MAC with a different secret must fail against the original seal.
  expect(parseJ9RunArtifact(sealed, "different_hmac_secret_value_32chars!!").ok).toBe(false);
});

it("keeps incomplete Checkout BLOCKED and rejects foreign sessions", () => {
  const runId = createRunId();
  const sealed = sealArtifact(hmacSecret, {
    schemaVersion: 2,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_home",
    priceTeam: "price_home",
    pauseCleanup: true,
    checkout: { customerId: "cus_a", sessionId: "cs_a", expectedPriceId: "price_home", subscriptionId: null },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: null,
      baselineInvoiceId: null,
      baselineEventIds: [],
    },
    resources: {
      customers: ["cus_a", "cus_b"],
      subscriptions: [],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
  });
  const incomplete = assertCompletedCheckoutSession({
    id: "cs_a",
    object: "checkout.session",
    livemode: false,
    status: "open",
    payment_status: "unpaid",
    customer: "cus_a",
    subscription: null,
  }, sealed);
  expect(incomplete.ok).toBe(false);
  if (!incomplete.ok) expect(incomplete.blocked).toBe(true);

  const foreign = assertCompletedCheckoutSession({
    id: "cs_other",
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    customer: "cus_a",
    subscription: "sub_a",
  }, sealed);
  expect(foreign.ok).toBe(false);
});

it("rejects missing customer/subscription associations in event correlation", () => {
  const event = parseStripeEvent({
    id: "evt_1",
    object: "event",
    livemode: false,
    created: 10,
    type: "invoice.payment_failed",
    data: { object: { id: "in_1", object: "invoice" } },
  });
  expect(event).not.toBeNull();
  const matched = correlateCustomerEvents(event ? [event] : [], {
    customerId: "cus_1",
    subscriptionId: "sub_1",
    types: ["invoice.payment_failed"],
  });
  expect(matched.matched).toEqual([]);
  expect(matched.rejected[0]).toContain("missing_association");
});

it("excludes baseline invoice.paid from recovery evidence", () => {
  const baseline = parseStripeEvent({
    id: "evt_base",
    object: "event",
    livemode: false,
    created: 1,
    type: "invoice.paid",
    data: { object: { id: "in_base", object: "invoice", customer: "cus_1", subscription: "sub_1" } },
  })!;
  const recovery = parseStripeEvent({
    id: "evt_recover",
    object: "event",
    livemode: false,
    created: 100,
    type: "invoice.paid",
    data: { object: { id: "in_recover", object: "invoice", customer: "cus_1", subscription: "sub_1" } },
  })!;
  const matched = correlateCustomerEvents([baseline, recovery], {
    customerId: "cus_1",
    subscriptionId: "sub_1",
    types: ["invoice.paid"],
    excludeEventIds: ["evt_base"],
    excludeInvoiceIds: ["in_base"],
    createdAfterSec: 50,
  });
  expect(matched.matched.map((row) => row.id)).toEqual(["evt_recover"]);
});

it("verifies webhook captures with header t and required event set", () => {
  const runId = createRunId();
  const created = Math.floor(Date.now() / 1000) - 10;
  const sessionBody = JSON.stringify({
    id: "evt_s",
    object: "event",
    type: "checkout.session.completed",
    created,
    data: { object: { id: "cs_1", object: "checkout.session", customer: "cus_1", subscription: "sub_1", metadata: { fizot_j9_run_id: runId } } },
  });
  const paidBody = JSON.stringify({
    id: "evt_p",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    data: { object: { id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_1", metadata: { fizot_j9_run_id: runId } } },
  });
  const ok = verifyWebhookCapture({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader(secret, sessionBody, created), provenance: "stripe_cli_listen" },
        { body: paidBody, stripeSignatureHeader: signStripeHeader(secret, paidBody, created + 1), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    webhookSecret: secret,
  });
  expect(ok.ok).toBe(true);

  const unrelated = verifyWebhookCapture({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        {
          body: JSON.stringify({
            id: "evt_other",
            object: "event",
            type: "customer.updated",
            created,
            data: { object: { id: "cus_other", object: "customer", metadata: {} } },
          }),
          stripeSignatureHeader: signStripeHeader(secret, JSON.stringify({
            id: "evt_other",
            object: "event",
            type: "customer.updated",
            created,
            data: { object: { id: "cus_other", object: "customer", metadata: {} } },
          }), created),
          provenance: "stripe_cli_listen",
        },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    webhookSecret: secret,
  });
  expect(unrelated.ok).toBe(false);

  const badSig = verifyWebhookCapture({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: "t=1,v1=deadbeef", provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    webhookSecret: secret,
  });
  expect(badSig.ok).toBe(false);
});

it("refuses abandoned cleanup without matching confirm and ownership", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  await runJ9({ env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }), transport, repoRoot: root });
  const artifact = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;

  const refused = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "cleanup", STRIPE_J9_CLEANUP_CONFIRM: "j9run_wrong" }),
    transport,
    repoRoot: root,
  });
  expect(refused.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("refused");

  const cleaned = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "cleanup", STRIPE_J9_CLEANUP_CONFIRM: artifact.artifact.runId }),
    transport,
    repoRoot: root,
  });
  expect(cleaned.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("PASS");
});

it("reports partial cleanup without marking abandoned while resources remain", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  await runJ9({ env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }), transport, repoRoot: root });
  const before = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(before.ok).toBe(true);
  if (!before.ok) return;
  transport.failCleanup = true;
  transport.cleanupFailStatus = 500;
  const cleaned = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "cleanup", STRIPE_J9_CLEANUP_CONFIRM: before.artifact.runId }),
    transport,
    repoRoot: root,
  });
  const row = cleaned.scenarios.find((item) => item.scenario === "cleanup");
  expect(row?.status).toBe("FAIL");
  expect(row?.cleanup).toBe("partial");
  const after = JSON.parse(readFileSync(artifactFile(root), "utf8")) as { stage: string };
  expect(after.stage).toBe("cleanup_partial");
});

it("blocks live acceptance when signed webhook capture coverage is incomplete", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  await runJ9({ env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }), transport, repoRoot: root });
  const artifact = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;
  transport.markCheckoutComplete(artifact.artifact.checkout.sessionId);
  const resumed = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(resumed.liveAcceptance).toBe(false);
  expect(resumed.overall).toBe("BLOCKED");
  expect(resumed.scenarios.find((row) => row.scenario === "webhook_lifecycle")?.status).toBe("BLOCKED");
});

it("distinguishes Test Clock advancing versus ready", async () => {
  const transport = createFakeStripeTransport();
  transport.clockAdvanceStatus = "advancing";
  const created = await transport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t" });
  const advancing = await advanceTestClockUntilReady({
    transport,
    clockId: String(created.id),
    targetFrozenTime: 2000,
    sleepMs: 0,
    maxAttempts: 2,
  });
  expect(advancing.ok).toBe(false);
});

it("tracks resources on mid-prepare failure for later cleanup", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const original = transport.request.bind(transport);
  let customers = 0;
  transport.request = async (method, path, params) => {
    if (method === "POST" && path === "customers") {
      customers += 1;
      if (customers >= 2) throw new Error("injected_prepare_failure");
    }
    return original(method, path, params);
  };
  const prepared = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }),
    transport,
    repoRoot: root,
  });
  expect(prepared.scenarios.some((row) => row.status === "FAIL")).toBe(true);
  const artifact = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;
  expect(artifact.artifact.resources.testClocks.length + artifact.artifact.resources.customers.length).toBeGreaterThan(0);
  expect(artifact.artifact.stage).toBe("cleanup_partial");
});
