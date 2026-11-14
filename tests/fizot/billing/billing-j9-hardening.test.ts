import { expect, it } from "vitest";
import { classifyCleanupError, J9StripeError, stripeErrorFromHttp } from "../../../server/fizot/billing/j9-errors.ts";
import { assertPaidInvoice } from "../../../server/fizot/billing/j9-invoice.ts";
import { formatJ9Report, finish, runJ9 } from "../../../server/fizot/billing/j9-driver.ts";
import { createFakeStripeTransport } from "../../../server/fizot/billing/j9-transport.ts";

const baseEnv = {
  STRIPE_J9_MODE: "test",
  STRIPE_J9_TRANSPORT: "fake",
  STRIPE_TEST_API_KEY: "sk_test_FAKE_KEY_DO_NOT_LEAK_OR_PRINT",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_j9_secret",
  STRIPE_J9_PRICE_HOME: "price_j9_test_home",
};

const expected = { customerId: "cus_1", subscriptionId: "sub_1" };

function validPaidInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_1",
    object: "invoice",
    livemode: false,
    paid: true,
    status: "paid",
    customer: "cus_1",
    subscription: "sub_1",
    ...overrides,
  };
}

it("accepts a fully valid paid test invoice", () => {
  const result = assertPaidInvoice(validPaidInvoice(), expected);
  expect(result).toEqual({ ok: true, invoiceId: "in_1", livemode: false, paid: true });
});

function modernPaidInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_modern",
    object: "invoice",
    livemode: false,
    status: "paid",
    attempted: true,
    amount_due: 1999,
    amount_paid: 1999,
    amount_remaining: 0,
    status_transitions: { paid_at: 1794531893 },
    customer: "cus_1",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
    ...overrides,
  };
}

it("accepts a genuinely paid modern Stripe invoice with parent subscription details", () => {
  expect(assertPaidInvoice(modernPaidInvoice(), expected)).toEqual({
    ok: true, invoiceId: "in_modern", livemode: false, paid: true,
  });
});

it("accepts a modern expanded parent subscription reference", () => {
  expect(assertPaidInvoice(modernPaidInvoice({
    parent: { type: "subscription_details", subscription_details: { subscription: { id: "sub_1" } } },
  }), expected).ok).toBe(true);
});

it("rejects modern invoices without sufficient independent payment evidence", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["missing paid timestamp", { status_transitions: {} }],
    ["null paid timestamp", { status_transitions: { paid_at: null } }],
    ["zero paid timestamp", { status_transitions: { paid_at: 0 } }],
    ["fractional paid timestamp", { status_transitions: { paid_at: 1.5 } }],
    ["unattempted", { attempted: false }],
    ["missing attempted", { attempted: undefined }],
    ["zero amount due", { amount_due: 0, amount_paid: 0 }],
    ["zero amount paid", { amount_paid: 0 }],
    ["incorrect amount paid", { amount_paid: 1000 }],
    ["noninteger amount paid", { amount_paid: "1999" }],
    ["remaining amount", { amount_remaining: 1 }],
    ["missing remaining amount", { amount_remaining: undefined }],
  ];
  for (const [name, overrides] of invalid) {
    expect(assertPaidInvoice(modernPaidInvoice(overrides), expected), name).toEqual({
      ok: false, reason: "invoice_paid_missing",
    });
  }
});

it("modern invoices still reject unpaid, live-mode, wrong customer and wrong subscription", () => {
  expect(assertPaidInvoice(modernPaidInvoice({ status: "open" }), expected)).toEqual({
    ok: false, reason: "invoice_status=open",
  });
  expect(assertPaidInvoice(modernPaidInvoice({ paid: false }), expected)).toEqual({
    ok: false, reason: "invoice_paid_flag_false",
  });
  expect(assertPaidInvoice(modernPaidInvoice({ livemode: true }), expected)).toEqual({
    ok: false, reason: "invoice_livemode_true",
  });
  expect(assertPaidInvoice(modernPaidInvoice({ customer: "cus_other" }), expected)).toEqual({
    ok: false, reason: "invoice_customer_mismatch",
  });
  expect(assertPaidInvoice(modernPaidInvoice({
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_other" } },
  }), expected)).toEqual({ ok: false, reason: "invoice_subscription_mismatch" });
  expect(assertPaidInvoice(modernPaidInvoice({ parent: null }), expected)).toEqual({
    ok: false, reason: "invoice_subscription_missing",
  });
});

it("rejects missing livemode", () => {
  const invoice = validPaidInvoice();
  delete (invoice as { livemode?: boolean }).livemode;
  expect(assertPaidInvoice(invoice, expected)).toEqual({ ok: false, reason: "invoice_livemode_missing" });
});

it("rejects livemode true", () => {
  expect(assertPaidInvoice(validPaidInvoice({ livemode: true }), expected)).toEqual({
    ok: false,
    reason: "invoice_livemode_true",
  });
});

it("rejects missing paid flag", () => {
  const invoice = validPaidInvoice();
  delete (invoice as { paid?: boolean }).paid;
  expect(assertPaidInvoice(invoice, expected)).toEqual({ ok: false, reason: "invoice_paid_missing" });
});

it("rejects paid false", () => {
  expect(assertPaidInvoice(validPaidInvoice({ paid: false, status: "open" }), expected)).toEqual({
    ok: false,
    reason: "invoice_paid_flag_false",
  });
});

it("rejects missing invoice id", () => {
  expect(assertPaidInvoice(validPaidInvoice({ id: "" }), expected)).toEqual({
    ok: false,
    reason: "invoice_id_missing",
  });
});

it("rejects incorrect customer", () => {
  expect(assertPaidInvoice(validPaidInvoice({ customer: "cus_other" }), expected)).toEqual({
    ok: false,
    reason: "invoice_customer_mismatch",
  });
});

it("rejects incorrect subscription", () => {
  expect(assertPaidInvoice(validPaidInvoice({ subscription: "sub_other" }), expected)).toEqual({
    ok: false,
    reason: "invoice_subscription_mismatch",
  });
});

it("grants no credit when Stripe returns an unpaid invoice", async () => {
  const transport = createFakeStripeTransport({ invoiceStatus: "open" });
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.overall).toBe("FAIL");
  expect(report.liveAcceptance).toBe(false);
  const payment = report.scenarios.find((row) => row.scenario === "subscription_payment_and_credit");
  expect(payment?.status).toBe("FAIL");
  expect(payment?.failureReason).toBe("invoice_paid_flag_false");
});

it("marks cleanup-only success without granting full live acceptance", () => {
  const cleaned = finish({
    kind: "live_j9",
    evaluationScope: "cleanup_only",
    resources: { customers: [], subscriptions: [], checkoutSessions: [], testClocks: [] },
    scenarios: [
      { scenario: "secure_startup", status: "PASS", source: "config", evidence: "stage=cleanup" },
      { scenario: "cleanup", status: "PASS", source: "stripe_api", evidence: "verified", cleanup: "complete" },
    ],
  });
  expect(cleaned.overall).toBe("PASS");
  expect(cleaned.exitCode).toBe(0);
  expect(cleaned.liveAcceptance).toBe(false);
  expect(cleaned.scenarios.find((row) => row.scenario === "checkout_completed")?.status).toBe("NOT_RUN");
  const full = finish({
    kind: "live_j9",
    resources: cleaned.resources,
    scenarios: cleaned.scenarios,
  });
  expect(full.overall).toBe("BLOCKED");
  expect(full.liveAcceptance).toBe(false);
});

it("cleanup-only scope fails closed on cleanup errors or missing evidence", () => {
  for (const [startup, cleanup, overall, exitCode] of [
    ["PASS", "FAIL", "FAIL", 1],
    ["FAIL", "PASS", "FAIL", 1],
    ["PASS", "BLOCKED", "BLOCKED", 2],
    ["PASS", "NOT_RUN", "BLOCKED", 2],
  ] as const) {
    const report = finish({
      kind: "live_j9",
      evaluationScope: "cleanup_only",
      resources: { customers: [], subscriptions: [], checkoutSessions: [], testClocks: [] },
      scenarios: [
        { scenario: "secure_startup", status: startup, source: "config", evidence: "startup" },
        { scenario: "cleanup", status: cleanup, source: "stripe_api", evidence: "cleanup" },
      ],
    });
    expect(report.overall).toBe(overall);
    expect(report.exitCode).toBe(exitCode);
    expect(report.liveAcceptance).toBe(false);
  }
});

it("tolerates verified already-absent cleanup states", () => {
  expect(classifyCleanupError("subscription", new J9StripeError({
    status: 404,
    code: "resource_missing",
    message: "gone",
  }))).toEqual({ action: "tolerate", reason: "resource_missing" });
  expect(classifyCleanupError("subscription", new J9StripeError({
    status: 400,
    code: "resource_already_deleted",
    message: "already canceled",
  }))).toEqual({ action: "tolerate", reason: "subscription_already_canceled" });
  expect(classifyCleanupError("checkout_session", new J9StripeError({
    status: 400,
    code: "checkout_session_already_expired",
    message: "expired",
  }))).toEqual({ action: "tolerate", reason: "session_already_closed" });
  expect(classifyCleanupError("customer", new J9StripeError({
    status: 404,
    code: "resource_already_deleted",
    message: "deleted",
  }))).toEqual({ action: "tolerate", reason: "customer_already_deleted" });
});

it("does not tolerate HTTP 500, 429, network, or misleading complete text", () => {
  expect(classifyCleanupError("subscription", new J9StripeError({
    status: 500,
    code: "api_error",
    message: "cleanup complete failed",
  }))).toEqual({ action: "fail", reason: "http_500" });
  expect(classifyCleanupError("customer", new J9StripeError({
    status: 429,
    code: "rate_limit",
    message: "slow down",
  }))).toEqual({ action: "fail", reason: "http_429" });
  expect(classifyCleanupError("checkout_session", new Error("network timeout"))).toEqual({
    action: "fail",
    reason: "untyped_or_network_error",
  });
  expect(classifyCleanupError("subscription", new Error("resource complete missing already"))).toEqual({
    action: "fail",
    reason: "untyped_or_network_error",
  });
});

it("parses Stripe HTTP error bodies into typed codes", () => {
  const err = stripeErrorFromHttp(404, JSON.stringify({
    error: { type: "invalid_request_error", code: "resource_missing", message: "No such customer" },
  }));
  expect(err).toBeInstanceOf(J9StripeError);
  expect(err.status).toBe(404);
  expect(err.code).toBe("resource_missing");
});

it("fails cleanup on Stripe HTTP 500 even when the message contains complete", async () => {
  const transport = createFakeStripeTransport();
  transport.failCleanup = true;
  transport.cleanupFailStatus = 500;
  transport.cleanupFailCode = "api_error";
  transport.cleanupFailMessage = "cleanup complete failed";
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("FAIL");
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.cleanup).toBe("partial");
  expect(report.overall).toBe("FAIL");
  expect(report.liveAcceptance).toBe(false);
});

it("fails cleanup on Stripe HTTP 429", async () => {
  const transport = createFakeStripeTransport();
  transport.failCleanup = true;
  transport.cleanupFailStatus = 429;
  transport.cleanupFailCode = "rate_limit";
  transport.cleanupFailMessage = "Too many requests";
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.failureReason).toContain("http_429");
  expect(report.overall).toBe("FAIL");
});

it("treats retry deletes of already-removed resources as successful cleanup", async () => {
  const transport = createFakeStripeTransport();
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("PASS");
  // Second delete of ids already cleaned by the run must be tolerated as resource_missing.
  const subId = report.resources.subscriptions[0]!;
  const customerId = report.resources.customers[0]!;
  await expect(transport.request("DELETE", `subscriptions/${subId}`, null)).rejects.toBeInstanceOf(J9StripeError);
  await expect(transport.request("DELETE", `customers/${customerId}`, null)).rejects.toBeInstanceOf(J9StripeError);
  expect(classifyCleanupError(
    "subscription",
    new J9StripeError({ status: 404, code: "resource_missing", message: "gone" }),
  ).action).toBe("tolerate");
});

it("keeps fake_unit PASS distinct from live acceptance and blocks live mandatory gaps", async () => {
  const report = await runJ9({ env: baseEnv, transport: createFakeStripeTransport() });
  expect(report.kind).toBe("fake_unit");
  expect(report.overall).toBe("PASS");
  expect(report.liveAcceptance).toBe(false);
  expect(formatJ9Report(report)).toContain("live_acceptance=false");

  const liveBlocked = finish({
    kind: "live_j9",
    resources: { customers: [], subscriptions: [], checkoutSessions: [] },
    scenarios: [
      { scenario: "secure_startup", status: "PASS", source: "config", evidence: "ok" },
      { scenario: "checkout_session_created", status: "PASS", source: "stripe_api", evidence: "ok" },
      { scenario: "checkout_completed", status: "BLOCKED", source: "stripe_api", evidence: "needs browser" },
      { scenario: "subscription_payment_and_credit", status: "PASS", source: "locally_signed_fixture", evidence: "ok" },
      { scenario: "webhook_lifecycle", status: "PASS", source: "locally_signed_fixture", evidence: "ok" },
      { scenario: "simulated_failed_payment_lifecycle", status: "PASS", source: "simulated_clock", evidence: "ok" },
      { scenario: "simulated_recovery", status: "PASS", source: "locally_signed_fixture", evidence: "ok" },
      { scenario: "stripe_dunning_recovery", status: "BLOCKED", source: "none", evidence: "no test clock" },
      { scenario: "tax_and_seats", status: "PASS", source: "stripe_api", evidence: "ok" },
      { scenario: "cleanup", status: "PASS", source: "stripe_api", evidence: "ok" },
    ],
  });
  expect(liveBlocked.overall).toBe("BLOCKED");
  expect(liveBlocked.liveAcceptance).toBe(false);
  expect(liveBlocked.exitCode).toBe(2);
});
