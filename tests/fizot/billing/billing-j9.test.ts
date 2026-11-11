import { expect, it } from "vitest";
import { formatJ9Report, finish, runJ9 } from "../../../server/fizot/billing/j9-driver.ts";
import { resolveJ9Config } from "../../../server/fizot/billing/j9-config.ts";
import { assertPaidInvoice } from "../../../server/fizot/billing/j9-invoice.ts";
import { createFakeStripeTransport } from "../../../server/fizot/billing/j9-transport.ts";

const baseEnv = {
  STRIPE_J9_MODE: "test",
  STRIPE_J9_TRANSPORT: "fake",
  STRIPE_TEST_API_KEY: "sk_test_FAKE_KEY_DO_NOT_LEAK_OR_PRINT",
  STRIPE_TEST_WEBHOOK_SECRET: "whsec_test_j9_secret",
  STRIPE_J9_PRICE_HOME: "price_j9_test_home",
  STRIPE_J9_PRICE_TEAM: "price_j9_test_team",
};

it("fails closed when credentials are missing", async () => {
  const report = await runJ9({ env: { STRIPE_J9_MODE: "test" } });
  expect(report.overall).toBe("BLOCKED");
  expect(report.exitCode).toBe(2);
  expect(report.liveAcceptance).toBe(false);
  expect(report.scenarios.find((row) => row.scenario === "secure_startup")?.status).toBe("BLOCKED");
  expect(formatJ9Report(report)).not.toMatch(/sk_test_|whsec_/);
});

it("rejects live Stripe keys", async () => {
  const report = await runJ9({
    env: { ...baseEnv, STRIPE_TEST_API_KEY: "sk_live_SHOULD_NEVER_RUN" },
  });
  expect(report.overall).toBe("FAIL");
  expect(report.exitCode).toBe(1);
  expect(report.liveAcceptance).toBe(false);
  expect(report.scenarios[0]?.failureReason).toContain("live");
  expect(formatJ9Report(report)).not.toContain("sk_live_SHOULD_NEVER_RUN");
});

it("rejects missing explicit test mode even when secrets exist", async () => {
  const report = await runJ9({
    env: {
      STRIPE_TEST_API_KEY: baseEnv.STRIPE_TEST_API_KEY,
      STRIPE_TEST_WEBHOOK_SECRET: baseEnv.STRIPE_TEST_WEBHOOK_SECRET,
      STRIPE_J9_PRICE_HOME: baseEnv.STRIPE_J9_PRICE_HOME,
    },
  });
  expect(report.overall).toBe("BLOCKED");
  expect(report.scenarios[0]?.evidence).toContain("STRIPE_J9_MODE");
});

it("blocks live transport when only unpublished placeholder prices are configured", () => {
  const resolved = resolveJ9Config({
    STRIPE_J9_MODE: "test",
    STRIPE_TEST_API_KEY: "sk_test_x",
    STRIPE_TEST_WEBHOOK_SECRET: "whsec_x",
    STRIPE_J9_PRICE_HOME: "price_unpublished_home",
    STRIPE_J9_TRANSPORT: "live",
  });
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) expect(resolved.status).toBe("BLOCKED");
});

it("runs the fake unit journey to PASS without live acceptance", async () => {
  const transport = createFakeStripeTransport();
  const lines: string[] = [];
  const report = await runJ9({ env: baseEnv, transport, log: (line) => lines.push(line) });
  expect(report.kind).toBe("fake_unit");
  expect(report.overall).toBe("PASS");
  expect(report.exitCode).toBe(0);
  expect(report.liveAcceptance).toBe(false);
  expect(report.scenarios.find((row) => row.scenario === "checkout_session_created")?.status).toBe("PASS");
  expect(report.scenarios.find((row) => row.scenario === "checkout_completed")?.evidence).toContain("fake_markCheckoutComplete_only");
  expect(report.scenarios.find((row) => row.scenario === "subscription_payment_and_credit")?.evidence).toContain("webhook_delivery=locally_signed_fixture");
  expect(report.scenarios.find((row) => row.scenario === "simulated_failed_payment_lifecycle")?.evidence).toContain("simulated_app_lifecycle");
  expect(transport.expiredSessions.length + transport.deletedCustomers.length).toBeGreaterThan(0);
  const text = formatJ9Report(report);
  expect(text).toContain("j9_kind=fake_unit");
  expect(text).toContain("live_acceptance=false");
  expect(text).not.toContain(baseEnv.STRIPE_TEST_API_KEY);
  expect(lines.join("\n")).not.toContain(baseEnv.STRIPE_TEST_API_KEY);
});

it("does not fabricate payment success when the invoice is missing", () => {
  const result = assertPaidInvoice(null, { customerId: "cus_1", subscriptionId: "sub_1" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("invoice_missing");
});

it("does not treat an unpaid invoice as payment success or credit evidence", async () => {
  const unpaid = assertPaidInvoice({
    id: "in_open",
    object: "invoice",
    status: "open",
    paid: false,
    livemode: false,
    customer: "cus_1",
    subscription: "sub_1",
  }, { customerId: "cus_1", subscriptionId: "sub_1" });
  expect(unpaid.ok).toBe(false);

  const transport = createFakeStripeTransport({ invoiceStatus: "open" });
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.overall).toBe("FAIL");
  expect(report.liveAcceptance).toBe(false);
  const payment = report.scenarios.find((row) => row.scenario === "subscription_payment_and_credit");
  expect(payment?.status).toBe("FAIL");
  expect(payment?.failureReason).toMatch(/invoice_status=open/);
});

it("does not pass full checkout E2E on an incomplete Checkout Session", async () => {
  const transport = createFakeStripeTransport();
  transport.markCheckoutComplete = () => {
    // Leave the session open: incomplete hosted Checkout.
  };
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.overall).not.toBe("PASS");
  expect(report.scenarios.find((row) => row.scenario === "checkout_completed")?.status).toBe("FAIL");
});

it("fails when Stripe seat quantity stays at 1 after an update", async () => {
  const transport = createFakeStripeTransport();
  transport.freezeQuantity = true;
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.overall).toBe("FAIL");
  const seats = report.scenarios.find((row) => row.scenario === "tax_and_seats");
  expect(seats?.status).toBe("FAIL");
  expect(seats?.failureReason).toContain("stripe_quantity=1");
});

it("rejects invalid webhook signatures", async () => {
  const report = await runJ9({ env: baseEnv, transport: createFakeStripeTransport() });
  expect(report.scenarios.find((row) => row.scenario === "webhook_lifecycle")?.evidence).toContain("invalid_signature=rejected");
});

it("labels simulated lifecycle events as fixtures, not Stripe deliveries", async () => {
  const report = await runJ9({ env: baseEnv, transport: createFakeStripeTransport() });
  expect(report.scenarios.find((row) => row.scenario === "simulated_failed_payment_lifecycle")?.source).toBe("simulated_clock");
  expect(report.scenarios.find((row) => row.scenario === "simulated_recovery")?.source).toBe("locally_signed_fixture");
  expect(report.scenarios.find((row) => row.scenario === "simulated_recovery")?.evidence).toContain("fixture");
});

it("fails overall PASS when cleanup cannot finish", async () => {
  const transport = createFakeStripeTransport();
  transport.failCleanup = true;
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("FAIL");
  expect(report.overall).toBe("FAIL");
  expect(report.exitCode).toBe(1);
});

it("never reports fake-mode success as live acceptance", async () => {
  const report = await runJ9({ env: baseEnv, transport: createFakeStripeTransport() });
  expect(report.kind).toBe("fake_unit");
  expect(report.liveAcceptance).toBe(false);
  expect(formatJ9Report(report)).toContain("live_acceptance=false");
});

it("refuses an injected fake transport under live config", async () => {
  const report = await runJ9({
    env: { ...baseEnv, STRIPE_J9_TRANSPORT: "live", STRIPE_J9_PRICE_HOME: "price_j9_live_shaped" },
    transport: createFakeStripeTransport(),
  });
  expect(report.kind).toBe("live_j9");
  expect(report.overall).toBe("FAIL");
  expect(report.liveAcceptance).toBe(false);
});

it("blocks live acceptance when a mandatory live scenario is BLOCKED", () => {
  const report = finish({
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
  expect(report.overall).toBe("BLOCKED");
  expect(report.exitCode).toBe(2);
  expect(report.liveAcceptance).toBe(false);
});

it("cannot report PASS when a mandatory scenario fails mid-journey", async () => {
  const transport = createFakeStripeTransport();
  const original = transport.request.bind(transport);
  let subscriptions = 0;
  transport.request = async (method, path, params) => {
    if (method === "POST" && path === "subscriptions") {
      subscriptions += 1;
      if (subscriptions === 1) throw new Error("stripe_402:card_declined");
    }
    return original(method, path, params);
  };
  const report = await runJ9({ env: baseEnv, transport });
  expect(report.overall).not.toBe("PASS");
  expect(report.liveAcceptance).toBe(false);
  expect(report.scenarios.some((row) => row.status === "FAIL")).toBe(true);
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("PASS");
});
