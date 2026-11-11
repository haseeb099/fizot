import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signStripeHeader } from "../../../server/fizot/admin/webhooks.ts";
import { runJ9 } from "../../../server/fizot/billing/j9-driver.ts";
import {
  assertCompletedCheckoutSession,
} from "../../../server/fizot/billing/j9-checkout-evidence.ts";
import {
  createRunId,
  createRunNonce,
  loadJ9RunArtifact,
  parseJ9RunArtifact,
  sealArtifact,
} from "../../../server/fizot/billing/j9-run-artifact.ts";
import {
  advanceTestClockUntilReady,
  correlateCustomerEvents,
  parseStripeEvent,
} from "../../../server/fizot/billing/j9-test-clock.ts";
import { createFakeStripeTransport } from "../../../server/fizot/billing/j9-transport.ts";
import { verifyWebhookCapture } from "../../../server/fizot/billing/j9-webhook-capture.ts";

const secret = "whsec_test_j9_live_evidence";
const liveEnv = {
  STRIPE_J9_MODE: "test",
  STRIPE_J9_TRANSPORT: "live",
  STRIPE_TEST_API_KEY: "sk_test_FAKE_KEY_DO_NOT_LEAK_OR_PRINT",
  STRIPE_TEST_WEBHOOK_SECRET: secret,
  STRIPE_J9_PRICE_HOME: "price_j9_test_home",
  STRIPE_J9_PRICE_TEAM: "price_j9_test_team",
};

function artifactPath(): string {
  return join(mkdtempSync(join(tmpdir(), "j9-art-")), "run.json");
}

it("resumes the same sealed test run after prepare", async () => {
  const path = artifactPath();
  const transport = createFakeStripeTransport();
  const prepared = await runJ9({
    env: { ...liveEnv, STRIPE_J9_STAGE: "prepare", STRIPE_J9_ARTIFACT_PATH: path },
    transport,
  });
  expect(prepared.overall).toBe("BLOCKED");
  expect(prepared.scenarios.find((row) => row.scenario === "checkout_completed")?.status).toBe("BLOCKED");
  expect(prepared.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");
  const artifact = loadJ9RunArtifact(path);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;

  transport.markCheckoutComplete(artifact.artifact.checkout.sessionId);
  const capturePath = join(dirnameOf(path), "capture.json");
  writeSignedCapture(capturePath, artifact.artifact.runId);

  const resumed = await runJ9({
    env: {
      ...liveEnv,
      STRIPE_J9_STAGE: "resume",
      STRIPE_J9_ARTIFACT_PATH: path,
      STRIPE_J9_WEBHOOK_CAPTURE_PATH: capturePath,
    },
    transport,
  });
  expect(resumed.scenarios.find((row) => row.scenario === "checkout_completed")?.status).toBe("PASS");
  expect(resumed.runId).toBe(artifact.artifact.runId);
  expect(resumed.scenarios.find((row) => row.scenario === "stripe_dunning_recovery")?.status).toBe("PASS");
});

it("rejects invalid resource ownership and foreign run ids", () => {
  const runId = createRunId();
  const sealed = sealArtifact({
    schemaVersion: 1,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_j9_test_home",
    priceTeam: "price_j9_test_home",
    runNonce: createRunNonce(),
    pauseCleanup: true,
    checkout: { customerId: "cus_a", sessionId: "cs_a", expectedPriceId: "price_j9_test_home" },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: "sub_a",
      baselineInvoiceId: "in_a",
    },
    resources: {
      customers: ["cus_a", "cus_b"],
      subscriptions: ["sub_a"],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
  });
  const tampered = { ...sealed, resourceMac: "00".repeat(32) };
  expect(parseJ9RunArtifact(tampered).ok).toBe(false);

  const completed = assertCompletedCheckoutSession({
    id: "cs_other",
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    customer: "cus_a",
    subscription: "sub_a",
  }, sealed);
  expect(completed.ok).toBe(false);
  if (!completed.ok) expect(completed.reason).toBe("checkout_session_foreign_run");
});

it("keeps incomplete Checkout BLOCKED", () => {
  const runId = createRunId();
  const sealed = sealArtifact({
    schemaVersion: 1,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_home",
    priceTeam: "price_home",
    runNonce: createRunNonce(),
    pauseCleanup: true,
    checkout: { customerId: "cus_a", sessionId: "cs_a", expectedPriceId: "price_home" },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: null,
      baselineInvoiceId: null,
    },
    resources: {
      customers: ["cus_a", "cus_b"],
      subscriptions: [],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
  });
  const result = assertCompletedCheckoutSession({
    id: "cs_a",
    object: "checkout.session",
    livemode: false,
    status: "open",
    payment_status: "unpaid",
    customer: "cus_a",
    subscription: null,
  }, sealed);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("checkout_incomplete");
  }
});

it("rejects wrong customer subscription invoice evidence", () => {
  const runId = createRunId();
  const sealed = sealArtifact({
    schemaVersion: 1,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_home",
    priceTeam: "price_home",
    runNonce: createRunNonce(),
    pauseCleanup: true,
    checkout: { customerId: "cus_expected", sessionId: "cs_a", expectedPriceId: "price_home" },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: null,
      baselineInvoiceId: null,
    },
    resources: {
      customers: ["cus_expected", "cus_b"],
      subscriptions: [],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
  });
  expect(assertCompletedCheckoutSession({
    id: "cs_a",
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    customer: "cus_wrong",
    subscription: "sub_a",
  }, sealed).ok).toBe(false);
});

it("distinguishes Test Clock advancing versus ready", async () => {
  const transport = createFakeStripeTransport();
  transport.clockAdvanceStatus = "advancing";
  const created = await transport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t" });
  const clockId = String(created.id);
  const advancing = await advanceTestClockUntilReady({
    transport,
    clockId,
    targetFrozenTime: 2000,
    sleepMs: 0,
    maxAttempts: 2,
  });
  expect(advancing.ok).toBe(false);
  if (!advancing.ok) expect(advancing.reason).toBe("test_clock_advance_timeout");

  transport.clockAdvanceStatus = "ready";
  const clock = await transport.request("GET", `test_helpers/test_clocks/${clockId}`, null);
  clock.status = "ready";
  // Force frozen_time catch-up then re-advance from current.
  const readyTransport = createFakeStripeTransport();
  const clock2 = await readyTransport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t2" });
  const ready = await advanceTestClockUntilReady({
    transport: readyTransport,
    clockId: String(clock2.id),
    targetFrozenTime: 5000,
    sleepMs: 0,
    maxAttempts: 3,
  });
  expect(ready.ok).toBe(true);
});

it("correlates Stripe events and rejects absent failure evidence", () => {
  const failed = parseStripeEvent({
    id: "evt_1",
    object: "event",
    livemode: false,
    created: 1,
    type: "invoice.payment_failed",
    data: { object: { id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_1" } },
  });
  expect(failed).not.toBeNull();
  const matched = correlateCustomerEvents(failed ? [failed] : [], {
    customerId: "cus_1",
    subscriptionId: "sub_1",
    types: ["invoice.payment_failed", "invoice.paid"],
  });
  expect(matched.missingTypes).toEqual(["invoice.paid"]);
});

it("treats recovery as unconfirmed when paid events are missing", async () => {
  const path = artifactPath();
  const transport = createFakeStripeTransport();
  // Suppress auto event emission by leaving clockAdvanceStatus ready but emptying events after prepare.
  const prepared = await runJ9({
    env: { ...liveEnv, STRIPE_J9_STAGE: "prepare", STRIPE_J9_ARTIFACT_PATH: path },
    transport,
  });
  expect(prepared.overall).toBe("BLOCKED");
  const artifact = loadJ9RunArtifact(path);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;
  transport.markCheckoutComplete(artifact.artifact.checkout.sessionId);
  // Clear events so dunning cannot find payment_failed.
  transport.events.length = 0;
  const originalPush = transport.pushEvent.bind(transport);
  // Replace request to swallow event creation side-effects: use advancing then ready without fail events.
  transport.clockAdvanceStatus = "ready";
  // Monkeypatch: after first advance, wipe events again.
  const inner = transport.request.bind(transport);
  let advances = 0;
  transport.request = async (method, pathName, params) => {
    const result = await inner(method, pathName, params);
    if (method === "POST" && pathName.endsWith("/advance")) {
      advances += 1;
      transport.events.length = 0;
    }
    return result;
  };
  const capturePath = join(dirnameOf(path), "capture.json");
  writeSignedCapture(capturePath, artifact.artifact.runId);
  const resumed = await runJ9({
    env: {
      ...liveEnv,
      STRIPE_J9_STAGE: "resume",
      STRIPE_J9_ARTIFACT_PATH: path,
      STRIPE_J9_WEBHOOK_CAPTURE_PATH: capturePath,
    },
    transport,
  });
  expect(advances).toBeGreaterThan(0);
  expect(resumed.scenarios.find((row) => row.scenario === "stripe_dunning_recovery")?.status).toMatch(/BLOCKED|FAIL/);
  originalPush({ id: "evt_x", object: "event", livemode: false, created: 1, type: "invoice.paid", data: { object: {} } });
});

it("supports interrupted prepare then retry-safe abandoned cleanup", async () => {
  const path = artifactPath();
  const transport = createFakeStripeTransport();
  const prepared = await runJ9({
    env: { ...liveEnv, STRIPE_J9_STAGE: "prepare", STRIPE_J9_ARTIFACT_PATH: path },
    transport,
  });
  expect(prepared.cleanup ?? prepared.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");
  const artifact = loadJ9RunArtifact(path);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;

  const refused = await runJ9({
    env: {
      ...liveEnv,
      STRIPE_J9_STAGE: "cleanup",
      STRIPE_J9_ARTIFACT_PATH: path,
      STRIPE_J9_CLEANUP_CONFIRM: "j9run_wrong",
    },
    transport,
  });
  expect(refused.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("FAIL");

  const cleaned = await runJ9({
    env: {
      ...liveEnv,
      STRIPE_J9_STAGE: "cleanup",
      STRIPE_J9_ARTIFACT_PATH: path,
      STRIPE_J9_CLEANUP_CONFIRM: artifact.artifact.runId,
    },
    transport,
  });
  expect(cleaned.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("PASS");
  expect(transport.deletedCustomers.length).toBeGreaterThan(0);
});

it("reports partial cleanup without claiming complete", async () => {
  const path = artifactPath();
  const transport = createFakeStripeTransport();
  await runJ9({
    env: { ...liveEnv, STRIPE_J9_STAGE: "prepare", STRIPE_J9_ARTIFACT_PATH: path },
    transport,
  });
  const artifact = loadJ9RunArtifact(path);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;
  transport.failCleanup = true;
  transport.cleanupFailStatus = 500;
  const cleaned = await runJ9({
    env: {
      ...liveEnv,
      STRIPE_J9_STAGE: "cleanup",
      STRIPE_J9_ARTIFACT_PATH: path,
      STRIPE_J9_CLEANUP_CONFIRM: artifact.artifact.runId,
    },
    transport,
  });
  const row = cleaned.scenarios.find((item) => item.scenario === "cleanup");
  expect(row?.status).toBe("FAIL");
  expect(row?.cleanup).toBe("partial");
});

it("blocks live acceptance when signed webhook capture is missing", async () => {
  const path = artifactPath();
  const transport = createFakeStripeTransport();
  await runJ9({
    env: { ...liveEnv, STRIPE_J9_STAGE: "prepare", STRIPE_J9_ARTIFACT_PATH: path },
    transport,
  });
  const artifact = loadJ9RunArtifact(path);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) return;
  transport.markCheckoutComplete(artifact.artifact.checkout.sessionId);
  const resumed = await runJ9({
    env: {
      ...liveEnv,
      STRIPE_J9_STAGE: "resume",
      STRIPE_J9_ARTIFACT_PATH: path,
    },
    transport,
  });
  expect(resumed.liveAcceptance).toBe(false);
  expect(resumed.overall).toBe("BLOCKED");
  expect(resumed.scenarios.find((row) => row.scenario === "webhook_lifecycle")?.status).toBe("BLOCKED");
});

it("verifies Stripe CLI signed captures and rejects wrong signatures", () => {
  const runId = createRunId();
  const body = JSON.stringify({
    id: "evt_capture_1",
    object: "event",
    type: "invoice.paid",
    created: 1_700_000_000,
    data: { object: { id: "in_1", object: "invoice" } },
  });
  const header = signStripeHeader(secret, body, 1_700_000_000);
  const ok = verifyWebhookCapture({
    capture: {
      schemaVersion: 1,
      kind: "stripe_cli_signed_capture",
      runId,
      deliveries: [{ body, stripeSignatureHeader: header }],
    },
    expectedRunId: runId,
    webhookSecret: secret,
  });
  expect(ok.ok).toBe(true);

  const bad = verifyWebhookCapture({
    capture: {
      schemaVersion: 1,
      kind: "stripe_cli_signed_capture",
      runId,
      deliveries: [{ body, stripeSignatureHeader: "t=1,v1=deadbeef" }],
    },
    expectedRunId: runId,
    webhookSecret: secret,
  });
  expect(bad.ok).toBe(false);
});

function dirnameOf(path: string): string {
  return path.replace(/[/\\][^/\\]+$/, "");
}

function writeSignedCapture(path: string, runId: string): void {
  const body = JSON.stringify({
    id: "evt_capture_live",
    object: "event",
    type: "invoice.paid",
    created: 1_700_000_100,
    livemode: false,
    data: { object: { id: "in_cap", object: "invoice", livemode: false } },
  });
  const header = signStripeHeader(secret, body, 1_700_000_100);
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    kind: "stripe_cli_signed_capture",
    runId,
    deliveries: [{ body, stripeSignatureHeader: header }],
  }));
}
