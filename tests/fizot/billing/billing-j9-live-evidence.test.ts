import { expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { signStripeHeader } from "../../../server/fizot/admin/webhooks.ts";
import { runJ9 } from "../../../server/fizot/billing/j9-driver.ts";
import { assertCompletedCheckoutSession } from "../../../server/fizot/billing/j9-checkout-evidence.ts";
import {
  createRunId,
  emptyDunningCheckpoint,
  loadJ9RunArtifact,
  parseJ9RunArtifact,
  persistArtifactUpdate,
  sealArtifact,
  J9_FIXED_ARTIFACT_RELATIVE,
  J9_FIXED_CAPTURE_RELATIVE,
} from "../../../server/fizot/billing/j9-run-artifact.ts";
import {
  advanceTestClockUntilReady,
  correlateCustomerEvents,
  ensureTestClockFrozenAt,
  parseStripeEvent,
} from "../../../server/fizot/billing/j9-test-clock.ts";
import { createFakeStripeTransport, type FakeStripeTransport } from "../../../server/fizot/billing/j9-transport.ts";
import {
  assertHttpsTransferUrl,
  captureBodyLooksSensitive,
  checkCaptureSignatureTimestamp,
  J9_CAPTURE_MAX_AGE_SEC,
  J9_WEBHOOK_CAPTURE_ARTIFACT_NAME,
  J9_WEBHOOK_CAPTURE_RELATIVE,
} from "../../../server/fizot/billing/j9-capture-policy.ts";
import {
  createPinnedTransferDispatcher,
  ensureCaptureInbox,
  fetchCaptureFromTransferUrl,
  ipv4MappedAddress,
  isBlockedIpAddress,
  isBlockedTransferHostname,
  J9_CAPTURE_MAX_BYTES,
  J9_CAPTURE_REMOTE_UPLOAD_ENABLED,
  J9_CAPTURE_TRANSFER_SECRET_NAME,
  readIncomingMessageBounded,
  readResponseBodyBounded,
  resolveAllowedTransferDestination,
  writeRestrictedFile,
} from "../../../server/fizot/billing/j9-capture-transfer.ts";
import {
  verifyWebhookCapture,
  verifyWebhookCaptureSignatures,
} from "../../../server/fizot/billing/j9-webhook-capture.ts";
import { cleanupTrackedResources, runStripeTestClockDunning } from "../../../server/fizot/billing/j9-live-stages.ts";

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

function writeSignedCapture(
  path: string,
  transport: FakeStripeTransport,
  input: {
    runId: string;
    customerId: string;
    subscriptionId: string;
    sessionId: string;
    omitRunMetadata?: boolean;
    invoiceAssociation?: "legacy" | "parent";
  },
): void {
  const created = Math.floor(Date.now() / 1000) - 10;
  const sessionMeta = input.omitRunMetadata ? {} : { fizot_j9_run_id: input.runId };
  const sessionObj = {
    id: input.sessionId,
    object: "checkout.session",
    customer: input.customerId,
    subscription: input.subscriptionId,
    metadata: sessionMeta,
  };
  // Realistic Stripe invoices often have empty metadata; ownership is on Session/Subscription.
  const invoiceObj: Record<string, unknown> = {
    id: "in_capture_paid",
    object: "invoice",
    customer: input.customerId,
    metadata: {},
  };
  if (input.invoiceAssociation === "parent") {
    invoiceObj.parent = {
      type: "subscription_details",
      subscription_details: { subscription: input.subscriptionId },
    };
  } else {
    invoiceObj.subscription = input.subscriptionId;
  }
  const sessionEvent = {
    id: "evt_capture_session",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: sessionObj },
  };
  const paidEvent = {
    id: "evt_capture_paid",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: invoiceObj },
  };
  if (!input.omitRunMetadata) {
    transport.seedOwnedCaptureJourney({
      runId: input.runId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      sessionId: input.sessionId,
      invoiceId: "in_capture_paid",
      invoiceAssociation: input.invoiceAssociation ?? "legacy",
    });
  }
  transport.pushEvent(sessionEvent);
  transport.pushEvent(paidEvent);
  const sessionBody = JSON.stringify(sessionEvent);
  const paidBody = JSON.stringify(paidEvent);
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

async function prepareAndCompleteCheckout(root: string, transport: FakeStripeTransport) {
  const prepared = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }),
    transport,
    repoRoot: root,
  });
  const artifact = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(artifact.ok).toBe(true);
  if (!artifact.ok) throw new Error("artifact missing");
  transport.markCheckoutComplete(artifact.artifact.checkout.sessionId);
  const session = await transport.request("GET", `checkout/sessions/${artifact.artifact.checkout.sessionId}`, null);
  return {
    prepared,
    artifact: artifact.artifact,
    sessionId: artifact.artifact.checkout.sessionId,
    customerId: artifact.artifact.checkout.customerId,
    subscriptionId: String(session.subscription),
  };
}

it("resumes the same sealed test run after prepare using Checkout subscription credit", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  expect(prepared.prepared.overall).toBe("BLOCKED");
  expect(prepared.prepared.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");

  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
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
  expect(resumed.scenarios.find((row) => row.scenario === "webhook_lifecycle")?.evidence).toContain("stripe_origin=true");
  expect(resumed.liveAcceptance).toBe(true);
});

it("retains resources when webhook capture is missing and persists awaiting_evidence", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  const beforeCustomers = [...transport.customers];
  const beforeClocks = [...transport.testClocks];

  const resumed = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(resumed.liveAcceptance).toBe(false);
  expect(resumed.overall).toBe("BLOCKED");
  expect(resumed.scenarios.find((row) => row.scenario === "webhook_lifecycle")?.status).toBe("BLOCKED");
  expect(resumed.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");
  const after = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.artifact.stage).toBe("awaiting_evidence");
  expect(after.artifact.retrySafe).toBe(true);
  expect(after.artifact.resources.customers.length).toBeGreaterThan(0);
  expect(transport.deletedCustomers).toEqual([]);
  expect(transport.deletedTestClocks).toEqual([]);
  expect(transport.customers).toEqual(beforeCustomers);
  expect(transport.testClocks).toEqual(beforeClocks);
  expect(after.artifact.runId).toBe(prepared.artifact.runId);
});

it("retains resources when Test Clock dunning is blocked", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
  });
  transport.clockAdvanceStatus = "internal_failure";

  const resumed = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(resumed.scenarios.find((row) => row.scenario === "stripe_dunning_recovery")?.status).not.toBe("PASS");
  expect(resumed.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");
  expect(transport.deletedTestClocks).toEqual([]);
  const after = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(["awaiting_evidence", "retryable_failure"]).toContain(after.artifact.stage);
  expect(after.artifact.resources.testClocks.length).toBeGreaterThan(0);
});

it("does not create duplicate Stripe resources on retry after incomplete verification", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  const first = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(first.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("retained");
  const customersAfterFirst = transport.customers.length;
  const clocksAfterFirst = transport.testClocks.length;
  const subsAfterFirst = transport.subscriptions.length;

  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
  });
  const second = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(transport.customers.length).toBe(customersAfterFirst);
  expect(transport.testClocks.length).toBe(clocksAfterFirst);
  expect(transport.subscriptions.length).toBe(subsAfterFirst);
  expect(second.scenarios.find((row) => row.scenario === "checkout_completed")?.status).toBe("PASS");
});

it("refuses duplicate resume of a completed run", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
  });
  const first = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(first.liveAcceptance).toBe(true);
  const second = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(second.scenarios.find((row) => row.scenario === "secure_startup")?.status).toBe("FAIL");
  expect(second.scenarios.find((row) => row.scenario === "secure_startup")?.failureReason).toBe("artifact_already_terminal");
});

it("rejects MAC tampering and substituted run payloads", () => {
  const runId = createRunId();
  const sealed = sealArtifact(hmacSecret, {
    schemaVersion: 4,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_j9_test_home",
    priceTeam: "price_j9_test_home",
    pauseCleanup: true,
    retrySafe: true,
    checkout: { customerId: "cus_a", sessionId: "cs_a", expectedPriceId: "price_j9_test_home", subscriptionId: null, creditInvoiceId: null },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: "sub_a",
      baselineInvoiceId: "in_a",
      baselineEventIds: ["evt_base"],
      dunning: emptyDunningCheckpoint(),
    },
    resources: {
      customers: ["cus_a", "cus_b"],
      subscriptions: ["sub_a"],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
    transitions: [{ at: new Date().toISOString(), from: "none", to: "awaiting_checkout", reason: "test" }],
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
  expect(parseJ9RunArtifact(sealed, "different_hmac_secret_value_32chars!!").ok).toBe(false);
});

it("keeps incomplete Checkout BLOCKED and rejects foreign sessions", () => {
  const runId = createRunId();
  const sealed = sealArtifact(hmacSecret, {
    schemaVersion: 4,
    kind: "live_j9_run",
    runId,
    stage: "awaiting_checkout",
    createdAt: new Date().toISOString(),
    workspaceId: `ws_j9_${runId.slice(6, 14)}`,
    priceHome: "price_home",
    priceTeam: "price_home",
    pauseCleanup: true,
    retrySafe: true,
    checkout: { customerId: "cus_a", sessionId: "cs_a", expectedPriceId: "price_home", subscriptionId: null, creditInvoiceId: null },
    clock: {
      clockId: "clock_a",
      frozenTime: 1,
      customerId: "cus_b",
      subscriptionId: null,
      baselineInvoiceId: null,
      baselineEventIds: [],
      dunning: emptyDunningCheckpoint(),
    },
    resources: {
      customers: ["cus_a", "cus_b"],
      subscriptions: [],
      checkoutSessions: ["cs_a"],
      testClocks: ["clock_a"],
    },
    transitions: [{ at: new Date().toISOString(), from: "none", to: "awaiting_checkout", reason: "test" }],
  });
  const incomplete = assertCompletedCheckoutSession({
    id: "cs_a",
    object: "checkout.session",
    livemode: false,
    status: "open",
    payment_status: "unpaid",
    customer: "cus_a",
    subscription: null,
    metadata: { fizot_j9_run_id: runId },
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
    metadata: { fizot_j9_run_id: runId },
  }, sealed);
  expect(foreign.ok).toBe(false);

  const missingMeta = assertCompletedCheckoutSession({
    id: "cs_a",
    object: "checkout.session",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    customer: "cus_a",
    subscription: "sub_a",
    metadata: {},
  }, sealed);
  expect(missingMeta.ok).toBe(false);
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

it("verifies webhook signatures separately from Stripe-origin and rejects missing Session run metadata", async () => {
  const transport = createFakeStripeTransport();
  const runId = createRunId();
  const created = Math.floor(Date.now() / 1000) - 10;
  const sessionBody = JSON.stringify({
    id: "evt_s",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: { id: "cs_1", object: "checkout.session", customer: "cus_1", subscription: "sub_1", metadata: { fizot_j9_run_id: runId } } },
  });
  const paidBody = JSON.stringify({
    id: "evt_p",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: { id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_1", metadata: {} } },
  });
  transport.seedOwnedCaptureJourney({
    runId,
    customerId: "cus_1",
    subscriptionId: "sub_1",
    sessionId: "cs_1",
    invoiceId: "in_1",
  });
  transport.pushEvent(JSON.parse(sessionBody));
  transport.pushEvent(JSON.parse(paidBody));

  const signed = verifyWebhookCaptureSignatures({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader(secret, sessionBody, created), provenance: "stripe_cli_listen" },
        { body: paidBody, stripeSignatureHeader: signStripeHeader(secret, paidBody, created + 1), provenance: "historical_export" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    expectedSessionId: "cs_1",
    webhookSecret: secret,
  });
  expect(signed.ok).toBe(true);
  if (signed.ok) {
    expect(signed.checks.signatureVerified).toBe(true);
    expect(signed.checks.provenanceIsOperatorClaimOnly).toBe(true);
    expect(signed.checks.stripeOriginVerified).toBe(false);
  }

  const live = await verifyWebhookCapture({
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
    expectedSessionId: "cs_1",
    webhookSecret: secret,
    transport,
  });
  expect(live.ok).toBe(true);
  if (live.ok) {
    expect(live.checks.stripeOriginVerified).toBe(true);
    expect(live.checks.ownershipVerified).toBe(true);
    expect(live.checks.provenanceIsOperatorClaimOnly).toBe(true);
  }

  const missingMetaBody = JSON.stringify({
    id: "evt_nometa",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: { id: "cs_1", object: "checkout.session", customer: "cus_1", subscription: "sub_1", metadata: {} } },
  });
  const missingMeta = verifyWebhookCaptureSignatures({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: missingMetaBody, stripeSignatureHeader: signStripeHeader(secret, missingMetaBody, created), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    expectedSessionId: "cs_1",
    webhookSecret: secret,
  });
  expect(missingMeta.ok).toBe(false);
  if (!missingMeta.ok) expect(missingMeta.reason).toBe("capture_event_run_metadata_missing");

  const wrongSubBody = JSON.stringify({
    id: "evt_wrong_sub",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: { id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_other", metadata: {} } },
  });
  const wrongSub = verifyWebhookCaptureSignatures({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader(secret, sessionBody, created), provenance: "stripe_cli_listen" },
        { body: wrongSubBody, stripeSignatureHeader: signStripeHeader(secret, wrongSubBody, created + 1), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    expectedSessionId: "cs_1",
    webhookSecret: secret,
  });
  expect(wrongSub.ok).toBe(false);

  const altered = verifyWebhookCaptureSignatures({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody + " ", stripeSignatureHeader: signStripeHeader(secret, sessionBody, created), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_1",
    expectedSubscriptionId: "sub_1",
    expectedSessionId: "cs_1",
    webhookSecret: secret,
  });
  expect(altered.ok).toBe(false);

  const missingOrigin = await verifyWebhookCapture({
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
    expectedSessionId: "cs_1",
    webhookSecret: secret,
    transport: createFakeStripeTransport(),
  });
  expect(missingOrigin.ok).toBe(false);
  if (!missingOrigin.ok) {
    expect(missingOrigin.blocked).toBe(true);
    expect(missingOrigin.checks.signatureVerified).toBe(true);
    expect(missingOrigin.checks.stripeOriginVerified).toBe(false);
  }
});

it("accepts invoice.paid with empty invoice metadata via modern parent.subscription_details", async () => {
  const transport = createFakeStripeTransport();
  const runId = createRunId();
  const created = Math.floor(Date.now() / 1000) - 10;
  const sessionBody = JSON.stringify({
    id: "evt_s_parent",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: { id: "cs_p", object: "checkout.session", customer: "cus_p", subscription: "sub_p", metadata: { fizot_j9_run_id: runId } } },
  });
  const paidBody = JSON.stringify({
    id: "evt_p_parent",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: {
      object: {
        id: "in_p",
        object: "invoice",
        customer: "cus_p",
        metadata: {},
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_p" } },
      },
    },
  });
  transport.seedOwnedCaptureJourney({
    runId,
    customerId: "cus_p",
    subscriptionId: "sub_p",
    sessionId: "cs_p",
    invoiceId: "in_p",
    invoiceAssociation: "parent",
  });
  transport.pushEvent(JSON.parse(sessionBody));
  transport.pushEvent(JSON.parse(paidBody));
  const live = await verifyWebhookCapture({
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
    expectedCustomerId: "cus_p",
    expectedSubscriptionId: "sub_p",
    expectedSessionId: "cs_p",
    webhookSecret: secret,
    transport,
  });
  expect(live.ok).toBe(true);
});

it("rejects invoice.paid that only matches customer without Checkout subscription ownership", async () => {
  const runId = createRunId();
  const created = Math.floor(Date.now() / 1000) - 10;
  const sessionBody = JSON.stringify({
    id: "evt_s_foreign",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: { id: "cs_own", object: "checkout.session", customer: "cus_same", subscription: "sub_own", metadata: { fizot_j9_run_id: runId } } },
  });
  const paidBody = JSON.stringify({
    id: "evt_p_foreign",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: { id: "in_foreign", object: "invoice", customer: "cus_same", subscription: "sub_foreign", metadata: {} } },
  });
  const signed = verifyWebhookCaptureSignatures({
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
    expectedCustomerId: "cus_same",
    expectedSubscriptionId: "sub_own",
    expectedSessionId: "cs_own",
    webhookSecret: secret,
  });
  expect(signed.ok).toBe(false);
  if (!signed.ok) expect(signed.reason).toBe("capture_event_subscription_mismatch");
});

it("resolves fixture aliases while retaining created PaymentMethod IDs and customer ownership", async () => {
  const transport = createFakeStripeTransport();
  const first = await transport.request("POST", "customers", null);
  const second = await transport.request("POST", "customers", null);
  const firstId = String(first.id);
  const secondId = String(second.id);
  const attached = await transport.request("POST", "payment_methods/pm_card_visa/attach", { customer: firstId });
  const attachedId = String(attached.id);
  expect(attachedId).toMatch(/^pm_j9_attached_/);
  expect(attachedId).not.toBe("pm_card_visa");

  await expect(transport.request("POST", `customers/${firstId}`, {
    "invoice_settings[default_payment_method]": "pm_card_visa",
  })).rejects.toThrow("payment_method_must_be_attached_to_customer");
  await expect(transport.request("POST", `customers/${secondId}`, {
    "invoice_settings[default_payment_method]": attachedId,
  })).rejects.toThrow("payment_method_must_be_attached_to_customer");
  await expect(transport.request("POST", `customers/${firstId}`, {
    "invoice_settings[default_payment_method]": attachedId,
  })).resolves.toMatchObject({
    invoice_settings: { default_payment_method: attachedId },
  });

  const created = await transport.request("POST", "payment_methods", { type: "card", "card[token]": "tok_visa" });
  const createdId = String(created.id);
  const createdAttached = await transport.request("POST", `payment_methods/${createdId}/attach`, { customer: firstId });
  expect(createdAttached.id).toBe(createdId);
  await expect(transport.request("POST", `customers/${firstId}`, {
    "invoice_settings[default_payment_method]": createdId,
  })).resolves.toMatchObject({
    invoice_settings: { default_payment_method: createdId },
  });
  await expect(transport.request("POST", `customers/${secondId}`, {
    "invoice_settings[default_payment_method]": createdId,
  })).rejects.toThrow("payment_method_must_be_attached_to_customer");
});

it("updates subscription-level default_payment_method for Test Clock failure and recovery", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  const path = artifactFile(root);
  const loaded = loadJ9RunArtifact(path, hmacSecret);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const withSub = persistArtifactUpdate(hmacSecret, path, loaded.artifact, {
    checkout: { ...loaded.artifact.checkout, subscriptionId: prepared.subscriptionId },
    resources: {
      ...loaded.artifact.resources,
      subscriptions: [...loaded.artifact.resources.subscriptions, prepared.subscriptionId],
    },
  });
  const clockSubId = loaded.artifact.clock.subscriptionId!;
  const before = await transport.request("GET", `subscriptions/${clockSubId}`, null);
  expect(before.default_payment_method).toMatch(/^pm_j9_attached_/);

  const mid = await runStripeTestClockDunning({
    transport,
    artifact: withSub,
    hmacSecret,
    artifactPath: path,
    sleepMs: 0,
  });
  expect(mid.scenario.status).toBe("PASS");
  const after = await transport.request("GET", `subscriptions/${clockSubId}`, null);
  expect(after.default_payment_method).toMatch(/^pm_j9_attached_/);
  expect(after.default_payment_method).not.toBe(before.default_payment_method);
  expect(mid.artifact.clock.dunning.failureInvoiceId).toBeTruthy();
  expect(mid.artifact.clock.dunning.recoveryInvoiceId).toBeTruthy();
  expect(mid.artifact.clock.dunning.recoveryInvoiceId).not.toBe(loaded.artifact.clock.baselineInvoiceId);
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
  const after = JSON.parse(readFileSync(artifactFile(root), "utf8")) as { stage: string; retrySafe: boolean };
  expect(after.stage).toBe("cleanup_partial");
  expect(after.retrySafe).toBe(false);
});

it("refuses foreign Checkout Session and foreign Test Clock cleanup", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  await runJ9({ env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }), transport, repoRoot: root });
  const loaded = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  const foreignSession = await cleanupTrackedResources({
    transport,
    resources: {
      ...loaded.artifact.resources,
      checkoutSessions: ["cs_foreign_not_owned"],
    },
    secrets: [],
    artifact: {
      ...loaded.artifact,
      resources: {
        ...loaded.artifact.resources,
        checkoutSessions: ["cs_foreign_not_owned"],
      },
    },
    hmacSecret,
    artifactPath: artifactFile(root),
  });
  expect(foreignSession.status).toBe("FAIL");
  expect(foreignSession.failureReason).toContain("ownership");

  const foreignClock = await cleanupTrackedResources({
    transport,
    resources: {
      customers: [],
      subscriptions: [],
      checkoutSessions: [],
      testClocks: ["clock_foreign"],
    },
    secrets: [],
    artifact: {
      ...loaded.artifact,
      resources: {
        ...loaded.artifact.resources,
        testClocks: ["clock_foreign"],
      },
    },
    hmacSecret,
    artifactPath: artifactFile(root),
  });
  expect(foreignClock.status).toBe("FAIL");
  expect(foreignClock.failureReason).toMatch(/ownership|clock/);
});

it("allows confirmed cleanup of MAC-valid expired artifacts", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  await runJ9({ env: liveEnv(root, { STRIPE_J9_STAGE: "prepare" }), transport, repoRoot: root });
  const loaded = loadJ9RunArtifact(artifactFile(root), hmacSecret);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const expired = sealArtifact(hmacSecret, {
    ...loaded.artifact,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(artifactFile(root), `${JSON.stringify(expired, null, 2)}\n`);
  expect(loadJ9RunArtifact(artifactFile(root), hmacSecret).ok).toBe(false);
  const cleaned = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "cleanup", STRIPE_J9_CLEANUP_CONFIRM: loaded.artifact.runId }),
    transport,
    repoRoot: root,
  });
  expect(cleaned.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("PASS");
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

it("does not re-advance a Test Clock already at the target frozen_time", async () => {
  const transport = createFakeStripeTransport();
  const created = await transport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t" });
  const first = await ensureTestClockFrozenAt({
    transport,
    clockId: String(created.id),
    targetFrozenTime: 2000,
    sleepMs: 0,
    maxAttempts: 3,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.skippedAdvance).toBe(false);
  const second = await ensureTestClockFrozenAt({
    transport,
    clockId: String(created.id),
    targetFrozenTime: 2000,
    sleepMs: 0,
    maxAttempts: 3,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.skippedAdvance).toBe(true);
  expect(second.clock.frozen_time).toBe(2000);
});

it("blocks reconcile-only when ready but below the committed advance target", async () => {
  const transport = createFakeStripeTransport();
  const created = await transport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t" });
  let advances = 0;
  const original = transport.request.bind(transport);
  transport.request = async (method, path, params) => {
    if (method === "POST" && path.endsWith("/advance")) advances += 1;
    return original(method, path, params);
  };
  const result = await ensureTestClockFrozenAt({
    transport,
    clockId: String(created.id),
    targetFrozenTime: 2000,
    allowAdvance: false,
    sleepMs: 0,
    maxAttempts: 3,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("advance_outcome_ambiguous");
  expect(advances).toBe(0);
});

it("polls an advancing clock without posting when reconcile-only", async () => {
  const transport = createFakeStripeTransport();
  transport.clockAdvanceStatus = "advancing";
  const created = await transport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t" });
  await transport.request("POST", `test_helpers/test_clocks/${String(created.id)}/advance`, { frozen_time: "2000" });
  let advances = 0;
  let gets = 0;
  const original = transport.request.bind(transport);
  transport.request = async (method, path, params) => {
    if (method === "POST" && path.endsWith("/advance")) {
      advances += 1;
      throw new Error("unexpected_advance_post");
    }
    const out = await original(method, path, params);
    if (method === "GET" && path.startsWith("test_helpers/test_clocks/")) {
      gets += 1;
      if (gets >= 2) return { ...out, status: "ready", frozen_time: 2000 };
    }
    return out;
  };
  const result = await ensureTestClockFrozenAt({
    transport,
    clockId: String(created.id),
    targetFrozenTime: 2000,
    allowAdvance: false,
    sleepMs: 0,
    maxAttempts: 5,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.skippedAdvance).toBe(true);
  expect(advances).toBe(0);
});

it("reconciles interruption after POST without repeating the advance", async () => {
  const transport = createFakeStripeTransport();
  const created = await transport.request("POST", "test_helpers/test_clocks", { frozen_time: "1000", name: "t" });
  // Simulate: committed intent, POST already sent, clock still advancing toward target.
  transport.clockAdvanceStatus = "advancing";
  await transport.request("POST", `test_helpers/test_clocks/${String(created.id)}/advance`, { frozen_time: "2000" });
  let advances = 0;
  let gets = 0;
  const original = transport.request.bind(transport);
  transport.request = async (method, path, params) => {
    if (method === "POST" && path.endsWith("/advance")) advances += 1;
    const out = await original(method, path, params);
    if (method === "GET" && path.startsWith("test_helpers/test_clocks/")) {
      gets += 1;
      if (gets >= 2) return { ...out, status: "ready", frozen_time: 2000 };
    }
    return out;
  };
  const result = await ensureTestClockFrozenAt({
    transport,
    clockId: String(created.id),
    targetFrozenTime: 2000,
    allowAdvance: false,
    sleepMs: 0,
    maxAttempts: 5,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.skippedAdvance).toBe(true);
  expect(advances).toBe(0);
  expect(result.clock.frozen_time).toBe(2000);
});

it("keeps failure_advance_committed and blocks when Stripe is ready below target", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  const path = artifactFile(root);
  const loaded = loadJ9RunArtifact(path, hmacSecret);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const failTarget = loaded.artifact.clock.frozenTime + 86400 + 3600;
  const committed = persistArtifactUpdate(hmacSecret, path, loaded.artifact, {
    checkout: { ...loaded.artifact.checkout, subscriptionId: prepared.subscriptionId },
    resources: {
      ...loaded.artifact.resources,
      subscriptions: [...loaded.artifact.resources.subscriptions, prepared.subscriptionId],
    },
    clock: {
      ...loaded.artifact.clock,
      dunning: {
        ...loaded.artifact.clock.dunning,
        phase: "failure_advance_committed",
        failTargetFrozenTime: failTarget,
      },
    },
  });
  let advances = 0;
  const original = transport.request.bind(transport);
  transport.request = async (method, pathName, params) => {
    if (method === "POST" && pathName.endsWith("/advance")) advances += 1;
    return original(method, pathName, params);
  };
  const resumed = await runStripeTestClockDunning({
    transport,
    artifact: committed,
    hmacSecret,
    artifactPath: path,
    sleepMs: 0,
  });
  expect(resumed.scenario.status).toBe("BLOCKED");
  expect(resumed.scenario.failureReason).toBe("advance_outcome_ambiguous");
  expect(advances).toBe(0);
  expect(resumed.artifact.clock.dunning.phase).toBe("failure_advance_committed");
  expect(resumed.artifact.clock.dunning.failTargetFrozenTime).toBe(failTarget);
});

it("resumes Test Clock dunning from authenticated checkpoints without repeating advances", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
  });

  const path = artifactFile(root);
  const loaded = loadJ9RunArtifact(path, hmacSecret);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  const withSub = persistArtifactUpdate(hmacSecret, path, loaded.artifact, {
    checkout: {
      ...loaded.artifact.checkout,
      subscriptionId: prepared.subscriptionId,
    },
    resources: {
      ...loaded.artifact.resources,
      subscriptions: loaded.artifact.resources.subscriptions.includes(prepared.subscriptionId)
        ? loaded.artifact.resources.subscriptions
        : [...loaded.artifact.resources.subscriptions, prepared.subscriptionId],
    },
  });

  const mid = await runStripeTestClockDunning({
    transport,
    artifact: withSub,
    hmacSecret,
    artifactPath: path,
    sleepMs: 0,
  });
  expect(mid.scenario.status).toBe("PASS");
  expect(mid.artifact.clock.dunning.phase).toBe("recovered");
  expect(mid.artifact.clock.dunning.failureInvoiceId).toBeTruthy();
  expect(mid.artifact.clock.dunning.recoveryInvoiceId).toBeTruthy();
  expect(mid.artifact.clock.dunning.recoveryInvoiceId).not.toBe(mid.artifact.clock.dunning.failureInvoiceId);
  expect(mid.artifact.clock.dunning.recoveryInvoiceId).not.toBe(loaded.artifact.clock.baselineInvoiceId);

  // Second call must skip side effects using recovered checkpoint.
  const again = await runStripeTestClockDunning({
    transport,
    artifact: mid.artifact,
    hmacSecret,
    artifactPath: path,
    sleepMs: 0,
  });
  expect(again.scenario.status).toBe("PASS");
  expect(again.scenario.evidence).toContain("skipped_side_effects=true");
  expect(again.artifact.clock.dunning.phase).toBe("recovered");
});

it("continues dunning after crash between failure confirmation and recovery advance", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  const path = artifactFile(root);
  const loaded = loadJ9RunArtifact(path, hmacSecret);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  // Drive to failure_confirmed via a full dunning run, then rewind phase to simulate crash before recovery advance.
  const withSub = persistArtifactUpdate(hmacSecret, path, loaded.artifact, {
    checkout: { ...loaded.artifact.checkout, subscriptionId: prepared.subscriptionId },
    resources: {
      ...loaded.artifact.resources,
      subscriptions: [...loaded.artifact.resources.subscriptions, prepared.subscriptionId],
    },
  });
  const full = await runStripeTestClockDunning({
    transport,
    artifact: withSub,
    hmacSecret,
    artifactPath: path,
    sleepMs: 0,
  });
  expect(full.scenario.status).toBe("PASS");

  const crashed = persistArtifactUpdate(hmacSecret, path, full.artifact, {
    clock: {
      ...full.artifact.clock,
      dunning: {
        ...full.artifact.clock.dunning,
        phase: "failure_confirmed",
        recoverTargetFrozenTime: null,
        recoveryInvoiceId: null,
        recoveryEventId: null,
      },
    },
  });
  const resumed = await runStripeTestClockDunning({
    transport,
    artifact: crashed,
    hmacSecret,
    artifactPath: path,
    sleepMs: 0,
  });
  expect(resumed.scenario.status).toBe("PASS");
  expect(resumed.artifact.clock.dunning.phase).toBe("recovered");
  // Recovery must still exclude baseline.
  expect(resumed.artifact.clock.dunning.recoveryInvoiceId).not.toBe(loaded.artifact.clock.baselineInvoiceId);
});

it("records isolated in-memory credit checkpoint evidence without claiming durable cross-run exactly-once", async () => {
  const root = repoFixture();
  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
  });
  const resumed = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(resumed.kind).toBe("live_j9");
  expect(resumed.liveAcceptance).toBe(true);
  const credit = resumed.scenarios.find((row) => row.scenario === "subscription_payment_and_credit");
  // In-memory billing-logic evidence only; durable ledger exactly-once stays P4.3/J4.
  expect(credit?.evidence).toContain("credit_checkpoint=");
  expect(credit?.evidence).toContain("credit_evidence=isolated_in_memory_billing_logic");

  const fake = await runJ9({
    env: {
      STRIPE_J9_MODE: "test",
      STRIPE_TEST_API_KEY: "sk_test_FAKE_KEY_DO_NOT_LEAK_OR_PRINT",
      STRIPE_TEST_WEBHOOK_SECRET: secret,
      STRIPE_J9_PRICE_HOME: "price_j9_test_home",
      STRIPE_J9_TRANSPORT: "fake",
    },
    transport: createFakeStripeTransport(),
  });
  expect(fake.kind).toBe("fake_unit");
  expect(fake.liveAcceptance).toBe(false);
});

it("documents capture artifact name/path and rejects unsafe transfer URLs", () => {
  expect(J9_WEBHOOK_CAPTURE_ARTIFACT_NAME).toBe("j9-webhook-capture");
  expect(J9_WEBHOOK_CAPTURE_RELATIVE.replace(/\\/g, "/")).toBe("artifacts/j9/webhook-capture.json");
  expect(J9_CAPTURE_TRANSFER_SECRET_NAME).toBe("STRIPE_J9_CAPTURE_TRANSFER_URL");
  expect(assertHttpsTransferUrl("").ok).toBe(false);
  expect(assertHttpsTransferUrl("http://example.invalid/cap.json").ok).toBe(false);
  expect(assertHttpsTransferUrl("https://user:pass@example.invalid/cap.json").ok).toBe(false);
  expect(assertHttpsTransferUrl("https://example.invalid/cap.json?x=1").ok).toBe(true);
  expect(captureBodyLooksSensitive('{"id":"evt_1"}')).toBe(false);
  expect(captureBodyLooksSensitive('{"x":"sk_test_leak"}')).toBe(true);
  expect(captureBodyLooksSensitive('{"number":"4242424242424242"}')).toBe(true);
  expect(isBlockedTransferHostname("localhost")).toBe(true);
  expect(isBlockedTransferHostname("127.0.0.1")).toBe(true);
  expect(isBlockedTransferHostname("metadata.google.internal")).toBe(true);
  expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
  expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
  expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
  expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
  expect(isBlockedIpAddress("::1")).toBe(true);
  expect(isBlockedIpAddress("fe80::1")).toBe(true);
  expect(isBlockedIpAddress("fc00::1")).toBe(true);
  expect(isBlockedIpAddress("fd12::1")).toBe(true);
  expect(ipv4MappedAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
  expect(isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
  expect(isBlockedIpAddress("::ffff:0a00:0001")).toBe(true); // 10.0.0.1
  expect(isBlockedIpAddress("::ffff:7f00:1")).toBe(true); // 127.0.0.1
  expect(isBlockedIpAddress("2001:4860:4860::8888")).toBe(false);
  expect(J9_CAPTURE_REMOTE_UPLOAD_ENABLED).toBe(true);
  expect(J9_CAPTURE_MAX_BYTES).toBe(2 * 1024 * 1024);
});

const publicDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];

it("rejects missing transfer credentials and never falls back to git commit paths", async () => {
  const root = repoFixture();
  const missing = await fetchCaptureFromTransferUrl({
    url: "",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async () => {
      throw new Error("fetch_must_not_run");
    },
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.reason).toBe("capture_transfer_url_missing");
  expect(existsSync(join(root, J9_WEBHOOK_CAPTURE_RELATIVE))).toBe(false);

  const embedded = await fetchCaptureFromTransferUrl({
    url: "https://token:secret@example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async () => {
      throw new Error("fetch_must_not_run");
    },
  });
  expect(embedded.ok).toBe(false);
  if (!embedded.ok) expect(embedded.reason).toBe("capture_transfer_url_must_not_embed_credentials");

  // Workflow must not expose the bearer URL as a dispatch input; local pack stays gitignored.
  const workflow = readFileSync(join(process.cwd(), ".github/workflows/billing-stripe-j9.yml"), "utf8");
  expect(workflow).not.toMatch(/capture_transfer_url:/);
  expect(workflow).toContain("secrets.STRIPE_J9_CAPTURE_TRANSFER_URL");
  expect(workflow).toContain("j9-fetch-capture-transfer.mjs");
  expect(workflow).toMatch(/No git commit fallback/i);
  const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
  expect(gitignore).toContain("artifacts/j9/webhook-capture.json");
  expect(gitignore).toContain("artifacts/j9/inbox/");
});

it("enforces HTTPS-only transfer, blocks private destinations, and rejects oversized or invalid capture payloads", async () => {
  const root = repoFixture();
  const capturePath = join(root, J9_WEBHOOK_CAPTURE_RELATIVE);
  writeFileSync(capturePath, '{"stale":true}\n');

  const httpOnly = await fetchCaptureFromTransferUrl({
    url: "http://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async () => {
      throw new Error("fetch_must_not_run");
    },
  });
  expect(httpOnly.ok).toBe(false);
  if (!httpOnly.ok) expect(httpOnly.reason).toBe("capture_transfer_url_must_be_https");
  expect(existsSync(capturePath)).toBe(false);

  const loopback = await fetchCaptureFromTransferUrl({
    url: "https://127.0.0.1/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async () => {
      throw new Error("fetch_must_not_run");
    },
  });
  expect(loopback.ok).toBe(false);
  if (!loopback.ok) expect(loopback.reason).toBe("capture_transfer_host_blocked");

  const privateResolved = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: async () => [{ address: "10.1.2.3", family: 4 }],
    fetchImpl: async () => {
      throw new Error("fetch_must_not_run");
    },
  });
  expect(privateResolved.ok).toBe(false);
  if (!privateResolved.ok) expect(privateResolved.reason).toBe("capture_transfer_resolved_address_blocked");

  const redirectError = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async (_url, init) => {
      expect(init?.redirect).toBe("error");
      throw Object.assign(new Error("redirect"), { name: "TypeError" });
    },
  });
  expect(redirectError.ok).toBe(false);
  if (!redirectError.ok) expect(redirectError.reason).toBe("capture_transfer_fetch_failed");
  expect(existsSync(capturePath)).toBe(false);

  const oversized = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    maxBytes: 32,
    fetchImpl: async () =>
      new Response("x".repeat(64), { status: 200, headers: { "content-type": "application/json" } }),
  });
  expect(oversized.ok).toBe(false);
  if (!oversized.ok) expect(oversized.reason).toBe("capture_transfer_too_large");
  expect(existsSync(capturePath)).toBe(false);

  let streamedChunks = 0;
  const streamedOversize = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    maxBytes: 16,
    fetchImpl: async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          streamedChunks += 1;
          if (streamedChunks <= 4) {
            controller.enqueue(new TextEncoder().encode("abcdefgh"));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  expect(streamedOversize.ok).toBe(false);
  if (!streamedOversize.ok) expect(streamedOversize.reason).toBe("capture_transfer_too_large");
  // Abort after exceeding 16 bytes (two 8-byte chunks); a third pull may race cancel.
  expect(streamedChunks).toBeGreaterThanOrEqual(2);
  expect(streamedChunks).toBeLessThan(8);
  expect(existsSync(capturePath)).toBe(false);

  const contentLengthOversize = await readResponseBodyBounded(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }),
    8,
    "999999",
  );
  expect(contentLengthOversize.ok).toBe(false);
  if (!contentLengthOversize.ok) expect(contentLengthOversize.reason).toBe("capture_transfer_too_large");

  const invalidSchema = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async () =>
      new Response(JSON.stringify({ schemaVersion: 1, kind: "nope" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  expect(invalidSchema.ok).toBe(false);
  if (!invalidSchema.ok) expect(invalidSchema.reason).toBe("capture_transfer_schema_invalid");
  expect(existsSync(capturePath)).toBe(false);

  const sensitive = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/cap.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        schemaVersion: 2,
        kind: "stripe_cli_signed_capture",
        runId: "j9run_abc",
        deliveries: [{ body: "sk_test_leaked", stripeSignatureHeader: "t=1,v1=x" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  expect(sensitive.ok).toBe(false);
  if (!sensitive.ok) expect(sensitive.reason).toBe("capture_transfer_sensitive_material");
  expect(existsSync(capturePath)).toBe(false);
});

it("pins transfer connect to validated public addresses and rejects DNS-rebinding / IPv6 bypass", async () => {
  const publicOnly = await resolveAllowedTransferDestination(
    "https://example.invalid/cap.json",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );
  expect(publicOnly.ok).toBe(true);
  if (!publicOnly.ok) return;

  // Rebinding: a later lookup that returns a private address must not be used for connect.
  let lookups = 0;
  const rebindingLookup = async () => {
    lookups += 1;
    if (lookups === 1) return [{ address: "93.184.216.34", family: 4 }];
    return [{ address: "169.254.169.254", family: 4 }];
  };
  const first = await resolveAllowedTransferDestination("https://example.invalid/cap.json", rebindingLookup);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.addresses.map((row) => row.address)).toEqual(["93.184.216.34"]);
  const dispatcher = createPinnedTransferDispatcher(first);
  // The pinned dispatcher must keep TCP on the validated address even if DNS would flip.
  expect(first.addresses.every((row) => !isBlockedIpAddress(row.address))).toBe(true);
  await dispatcher.close();

  const reboundDenied = await resolveAllowedTransferDestination(
    "https://example.invalid/cap.json",
    async () => [{ address: "169.254.169.254", family: 4 }],
  );
  expect(reboundDenied.ok).toBe(false);
  if (!reboundDenied.ok) expect(reboundDenied.reason).toBe("capture_transfer_resolved_address_blocked");

  const mappedDenied = await resolveAllowedTransferDestination(
    "https://example.invalid/cap.json",
    async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
  );
  expect(mappedDenied.ok).toBe(false);
  if (!mappedDenied.ok) expect(mappedDenied.reason).toBe("capture_transfer_resolved_address_blocked");

  const ulaDenied = await resolveAllowedTransferDestination(
    "https://example.invalid/cap.json",
    async () => [{ address: "fd00::1", family: 6 }],
  );
  expect(ulaDenied.ok).toBe(false);
  if (!ulaDenied.ok) expect(ulaDenied.reason).toBe("capture_transfer_resolved_address_blocked");

  const mixedDenied = await resolveAllowedTransferDestination(
    "https://example.invalid/cap.json",
    async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ],
  );
  expect(mixedDenied.ok).toBe(false);
  if (!mixedDenied.ok) expect(mixedDenied.reason).toBe("capture_transfer_resolved_address_blocked");
});

it("rejects oversized local webhook deliveries without writing inbox evidence", async () => {
  const root = repoFixture();
  const inbox = ensureCaptureInbox(root);
  const before = readdirSync(inbox);
  const oversize = Readable.from([Buffer.alloc(64, 0x61)]);
  const req = oversize as unknown as IncomingMessage;
  req.headers = { "content-length": "64", "stripe-signature": "t=1,v1=abc" };
  const read = await readIncomingMessageBounded(req, 16);
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.reason).toBe("capture_transfer_too_large");
  expect(readdirSync(inbox)).toEqual(before);

  const streamOversize = Readable.from([
    Buffer.alloc(10, 0x62),
    Buffer.alloc(10, 0x63),
    Buffer.alloc(10, 0x64),
  ]);
  const req2 = streamOversize as unknown as IncomingMessage;
  req2.headers = { "stripe-signature": "t=1,v1=abc" };
  const read2 = await readIncomingMessageBounded(req2, 16);
  expect(read2.ok).toBe(false);
  if (!read2.ok) expect(read2.reason).toBe("capture_transfer_too_large");
  expect(readdirSync(inbox)).toEqual(before);
});

it("writes restricted local capture paths and resumes after a successful secure transfer", async () => {
  const root = repoFixture();
  const inbox = ensureCaptureInbox(root);
  if (process.platform !== "win32") {
    expect(statSync(inbox).mode & 0o777).toBe(0o700);
  }
  const bodyPath = join(inbox, "sample.body.json");
  writeRestrictedFile(bodyPath, '{"ok":true}\n');
  if (process.platform !== "win32") {
    expect(statSync(bodyPath).mode & 0o777).toBe(0o600);
  }

  const transport = createFakeStripeTransport();
  const prepared = await prepareAndCompleteCheckout(root, transport);
  writeSignedCapture(captureFile(root), transport, {
    runId: prepared.artifact.runId,
    customerId: prepared.customerId,
    subscriptionId: prepared.subscriptionId,
    sessionId: prepared.sessionId,
  });
  const rawCapture = readFileSync(captureFile(root), "utf8");
  const payload = rawCapture.endsWith("\n") ? rawCapture : `${rawCapture}\n`;
  // Simulate operator clearing local disk before Actions fetch.
  writeFileSync(captureFile(root), '{"stale_local":true}\n');

  const fetched = await fetchCaptureFromTransferUrl({
    url: "https://example.invalid/j9-capture.json",
    repoRoot: root,
    dnsLookup: publicDnsLookup,
    fetchImpl: async (url, init) => {
      expect(String(url)).toBe("https://example.invalid/j9-capture.json");
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("GET");
      return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  expect(fetched.ok).toBe(true);
  if (!fetched.ok) return;
  expect(fetched.bytes).toBe(Buffer.byteLength(payload));
  expect(existsSync(join(root, J9_WEBHOOK_CAPTURE_RELATIVE))).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(join(root, J9_WEBHOOK_CAPTURE_RELATIVE)).mode & 0o777).toBe(0o600);
  }

  const resumed = await runJ9({
    env: liveEnv(root, { STRIPE_J9_STAGE: "resume" }),
    transport,
    repoRoot: root,
  });
  expect(resumed.kind).toBe("live_j9");
  expect(resumed.liveAcceptance).toBe(true);
});

it("accepts staged captures aged 5m/30m/several hours and rejects beyond 48h or future t=", () => {
  const runId = createRunId();
  const baseCreated = Math.floor(Date.now() / 1000) - 10;
  function pairAt(createdSec: number) {
    const sessionBody = JSON.stringify({
      id: `evt_s_${createdSec}`,
      object: "event",
      type: "checkout.session.completed",
      created: createdSec,
      livemode: false,
      data: { object: { id: "cs_age", object: "checkout.session", customer: "cus_age", subscription: "sub_age", metadata: { fizot_j9_run_id: runId } } },
    });
    const paidBody = JSON.stringify({
      id: `evt_p_${createdSec}`,
      object: "event",
      type: "invoice.paid",
      created: createdSec + 1,
      livemode: false,
      data: { object: { id: "in_age", object: "invoice", customer: "cus_age", subscription: "sub_age", metadata: {} } },
    });
    return {
      schemaVersion: 2 as const,
      kind: "stripe_cli_signed_capture" as const,
      runId,
      capturedAt: new Date(createdSec * 1000).toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader(secret, sessionBody, createdSec), provenance: "stripe_cli_listen" as const },
        { body: paidBody, stripeSignatureHeader: signStripeHeader(secret, paidBody, createdSec + 1), provenance: "stripe_cli_listen" as const },
      ],
    };
  }
  const ages = [
    { label: "5m", ageSec: 5 * 60, expectOk: true },
    { label: "30m", ageSec: 30 * 60, expectOk: true },
    { label: "6h", ageSec: 6 * 60 * 60, expectOk: true },
    { label: "beyond_48h", ageSec: J9_CAPTURE_MAX_AGE_SEC + 120, expectOk: false },
  ];
  for (const row of ages) {
    const createdSec = baseCreated - row.ageSec;
    const nowMs = (baseCreated + 10) * 1000;
    const signed = verifyWebhookCaptureSignatures({
      capture: pairAt(createdSec),
      expectedRunId: runId,
      expectedCustomerId: "cus_age",
      expectedSubscriptionId: "sub_age",
      expectedSessionId: "cs_age",
      webhookSecret: secret,
      nowMs,
    });
    expect(signed.ok).toBe(row.expectOk);
    if (!row.expectOk && !signed.ok) {
      expect(signed.reason).toBe("capture_signature_expired");
    }
  }
  const future = checkCaptureSignatureTimestamp({
    timestampSec: Math.floor(Date.now() / 1000) + 3600,
    nowMs: Date.now(),
  });
  expect(future.ok).toBe(false);
  if (!future.ok) expect(future.reason).toBe("capture_timestamp_in_future");
});

it("resumes verification with a several-hour-old valid capture bound to the run", async () => {
  const transport = createFakeStripeTransport();
  const runId = createRunId();
  const created = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
  const sessionBody = JSON.stringify({
    id: "evt_old_s",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: { id: "cs_old", object: "checkout.session", customer: "cus_old", subscription: "sub_old", metadata: { fizot_j9_run_id: runId } } },
  });
  const paidBody = JSON.stringify({
    id: "evt_old_p",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: { id: "in_old", object: "invoice", customer: "cus_old", subscription: "sub_old", metadata: {} } },
  });
  transport.seedOwnedCaptureJourney({
    runId,
    customerId: "cus_old",
    subscriptionId: "sub_old",
    sessionId: "cs_old",
    invoiceId: "in_old",
  });
  transport.pushEvent(JSON.parse(sessionBody));
  transport.pushEvent(JSON.parse(paidBody));
  const live = await verifyWebhookCapture({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date(created * 1000).toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader(secret, sessionBody, created), provenance: "stripe_cli_listen" },
        { body: paidBody, stripeSignatureHeader: signStripeHeader(secret, paidBody, created + 1), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_old",
    expectedSubscriptionId: "sub_old",
    expectedSessionId: "cs_old",
    webhookSecret: secret,
    transport,
    nowMs: Date.now(),
  });
  expect(live.ok).toBe(true);
  if (live.ok) {
    expect(live.checks.signatureVerified).toBe(true);
    expect(live.checks.stripeOriginVerified).toBe(true);
    expect(live.checks.ownershipVerified).toBe(true);
    expect(live.checks.provenanceIsOperatorClaimOnly).toBe(true);
  }
});

it("rejects invalid HMAC, wrong subscription, and missing Stripe Event origin for captures", async () => {
  const runId = createRunId();
  const created = Math.floor(Date.now() / 1000) - 600;
  const sessionBody = JSON.stringify({
    id: "evt_bad_s",
    object: "event",
    type: "checkout.session.completed",
    created,
    livemode: false,
    data: { object: { id: "cs_bad", object: "checkout.session", customer: "cus_bad", subscription: "sub_bad", metadata: { fizot_j9_run_id: runId } } },
  });
  const paidBody = JSON.stringify({
    id: "evt_bad_p",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: { id: "in_bad", object: "invoice", customer: "cus_bad", subscription: "sub_bad", metadata: {} } },
  });
  const badHmac = verifyWebhookCaptureSignatures({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader("whsec_wrong", sessionBody, created), provenance: "stripe_cli_listen" },
        { body: paidBody, stripeSignatureHeader: signStripeHeader(secret, paidBody, created + 1), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_bad",
    expectedSubscriptionId: "sub_bad",
    expectedSessionId: "cs_bad",
    webhookSecret: secret,
  });
  expect(badHmac.ok).toBe(false);

  const wrongSubBody = JSON.stringify({
    id: "evt_bad_p2",
    object: "event",
    type: "invoice.paid",
    created: created + 1,
    livemode: false,
    data: { object: { id: "in_bad2", object: "invoice", customer: "cus_bad", subscription: "sub_other", metadata: {} } },
  });
  const wrongSub = verifyWebhookCaptureSignatures({
    capture: {
      schemaVersion: 2,
      kind: "stripe_cli_signed_capture",
      runId,
      capturedAt: new Date().toISOString(),
      deliveries: [
        { body: sessionBody, stripeSignatureHeader: signStripeHeader(secret, sessionBody, created), provenance: "stripe_cli_listen" },
        { body: wrongSubBody, stripeSignatureHeader: signStripeHeader(secret, wrongSubBody, created + 1), provenance: "stripe_cli_listen" },
      ],
    },
    expectedRunId: runId,
    expectedCustomerId: "cus_bad",
    expectedSubscriptionId: "sub_bad",
    expectedSessionId: "cs_bad",
    webhookSecret: secret,
  });
  expect(wrongSub.ok).toBe(false);

  const missingOrigin = await verifyWebhookCapture({
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
    expectedCustomerId: "cus_bad",
    expectedSubscriptionId: "sub_bad",
    expectedSessionId: "cs_bad",
    webhookSecret: secret,
    transport: createFakeStripeTransport(),
  });
  expect(missingOrigin.ok).toBe(false);
  if (!missingOrigin.ok) {
    expect(missingOrigin.blocked).toBe(true);
    expect(missingOrigin.checks.stripeOriginVerified).toBe(false);
  }
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
