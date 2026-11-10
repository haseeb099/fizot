import { expect, it } from "vitest";
import { formatJ9Report, runJ9 } from "../../../server/fizot/billing/j9-driver.ts";
import { resolveJ9Config } from "../../../server/fizot/billing/j9-config.ts";
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
  expect(report.scenarios.find((row) => row.scenario === "secure_startup")?.status).toBe("BLOCKED");
  expect(report.scenarios.every((row) => row.scenario === "secure_startup" || row.status === "NOT_RUN")).toBe(true);
  expect(formatJ9Report(report)).not.toMatch(/sk_test_|whsec_/);
});

it("rejects live Stripe keys", async () => {
  const report = await runJ9({
    env: {
      ...baseEnv,
      STRIPE_TEST_API_KEY: "sk_live_SHOULD_NEVER_RUN",
    },
  });
  expect(report.overall).toBe("FAIL");
  expect(report.exitCode).toBe(1);
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

it("runs the full fake journey to PASS without contacting Stripe", async () => {
  const transport = createFakeStripeTransport();
  const lines: string[] = [];
  const report = await runJ9({
    env: baseEnv,
    transport,
    log: (line) => lines.push(line),
  });
  expect(report.overall).toBe("PASS");
  expect(report.exitCode).toBe(0);
  expect(report.scenarios.every((row) => row.status === "PASS")).toBe(true);
  expect(transport.deletedCustomers.length).toBeGreaterThan(0);
  expect(transport.deletedSubscriptions.length).toBeGreaterThan(0);
  const text = formatJ9Report(report);
  expect(text).toContain("j9_overall=PASS");
  expect(text).not.toContain(baseEnv.STRIPE_TEST_API_KEY);
  expect(text).not.toContain(baseEnv.STRIPE_TEST_WEBHOOK_SECRET);
  expect(lines.join("\n")).not.toContain(baseEnv.STRIPE_TEST_API_KEY);
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
  expect(report.exitCode).not.toBe(0);
  expect(report.scenarios.some((row) => row.status === "FAIL")).toBe(true);
  expect(report.scenarios.find((row) => row.scenario === "cleanup")?.status).toBe("PASS");
});
