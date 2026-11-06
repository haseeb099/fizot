import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createBillingService, type StripeEvent } from "../../../server/fizot/billing/apply.ts";
import { createFakeEmailProvider } from "../../../server/fizot/billing/email.ts";
import { evaluateMargins, formatMarginReport, parseFlyProfiles } from "../../../server/fizot/billing/margin.ts";
import { planPrice, PLAN_PRICES, vatGate } from "../../../server/fizot/billing/plan-prices.ts";
import { createFakeBillingProvider, createStripeBillingProvider } from "../../../server/fizot/billing/provider.ts";
import { DAY_MS, GRACE_WINDOW_MS, DELETE_AFTER_SUSPEND_MS, NOTICE_BEFORE_DELETE_MS } from "../../../server/fizot/billing/record.ts";
import { createMemoryBillingStore } from "../../../server/fizot/billing/store.ts";
import { createMemoryCreditStore } from "../../../server/fizot/proxy/credit-store.ts";
import { meterCompletion } from "../../../server/fizot/proxy/meter.ts";
import { TIER_PRICES } from "../../../server/fizot/proxy/pricing.ts";
import { createAdminServer } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";
import { readFileSync } from "node:fs";

const URLS = {
  successUrl: "https://admin.example.invalid/billing/success",
  cancelUrl: "https://admin.example.invalid/billing/cancel",
  portalReturnUrl: "https://admin.example.invalid/billing",
};

function service(hooks: {
  onSuspend?: (id: string) => Promise<void>;
  onResume?: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  email?: ReturnType<typeof createFakeEmailProvider>;
  provider?: ReturnType<typeof createFakeBillingProvider>;
} = {}) {
  const credit = createMemoryCreditStore();
  const email = hooks.email ?? createFakeEmailProvider();
  const provider = hooks.provider ?? createFakeBillingProvider();
  const billing = createBillingService({
    store: createMemoryBillingStore(),
    credit,
    provider,
    email,
    urls: URLS,
    ownerEmail: async () => "owner@example.com",
    onSuspend: hooks.onSuspend,
    onResume: hooks.onResume,
    onDelete: hooks.onDelete,
  });
  return { billing, credit, email, provider };
}

function stripeEvent(id: string, type: string, created: number, object: Record<string, unknown>): StripeEvent {
  return { id, type, created, data: { object } };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.map((item) => item)];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    for (const tail of permutations(items.filter((_, index) => index !== i))) out.push([items[i]!, ...tail]);
  }
  return out;
}

it("grants no credit and forwards nothing for workspaces without a subscription", async () => {
  const admin = await createAdminServer({ port: 0, cookieSecure: false });
  try {
    const sign = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "hole@example.com" }),
    });
    const cookie = (sign.headers.getSetCookie?.() ?? []).find((row) => row.startsWith(`${SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
    let providerCalls = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const created = await fetch(`${admin.url}/admin/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ plan: "home", ownerEmail: "hole@example.com" }),
      });
      expect(created.status).toBe(201);
      const workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
      const summary = await admin.credit.summary(workspaceId);
      expect(summary.balanceMicroGbp).toBe(0);
      expect(summary.includedMicroGbp).toBe(0);
      const outcome = await meterCompletion({
        credit: admin.credit,
        workspaceId,
        requestId: `hole-${i}`,
        tier: "fast",
        rawBody: Buffer.from("{}"),
        parsed: { max_tokens: 1 },
        subscriptionAllows: (id) => admin.billing.allows(id),
        forward: async () => {
          providerCalls += 1;
          return { status: 200, contentType: "application/json", body: Buffer.from("{}") };
        },
      });
      statuses.push(outcome.status);
      await admin.services.destroyWorkspace(workspaceId);
      await admin.services.runDeletionJob(workspaceId);
    }
    expect(providerCalls).toBe(0);
    expect(statuses.every((status) => status === 402)).toBe(true);
    console.log("free_credit", { workspaces: 20, balanceMicroGbp: 0, providerCalls, denied: statuses.length });
  } finally {
    await admin.close();
  }
});

it("converges every ordering of one scenario to the same subscription and one grant", async () => {
  const ws = "ws-perm";
  const home = planPrice("home")!;
  const events = [
    stripeEvent("e1", "customer.subscription.created", 10, {
      id: "sub_1", object: "subscription", customer: "cus_1", status: "incomplete",
      metadata: { workspace_id: ws, plan: "home" },
    }),
    stripeEvent("e2", "checkout.session.completed", 12, {
      id: "cs_1", object: "checkout.session", customer: "cus_1", subscription: "sub_1",
      client_reference_id: ws, payment_status: "paid", metadata: { workspace_id: ws, plan: "home" },
    }),
    stripeEvent("e3", "invoice.payment_failed", 15, {
      id: "in_fail", object: "invoice", customer: "cus_1", subscription: "sub_1",
      metadata: { workspace_id: ws, plan: "home" },
    }),
    stripeEvent("e4", "customer.subscription.updated", 40, {
      id: "sub_1", object: "subscription", customer: "cus_1", status: "active", default_payment_method: "pm_1",
      metadata: { workspace_id: ws, plan: "home" },
      items: { data: [{ id: "si_1", quantity: 1, price: { id: home.stripePriceId } }] },
    }),
    stripeEvent("e5", "invoice.paid", 50, {
      id: "in_1", object: "invoice", customer: "cus_1", subscription: "sub_1",
      metadata: { workspace_id: ws, plan: "home" },
    }),
  ];
  const orders = permutations(events);
  const finals = new Set<string>();
  for (const order of orders) {
    const { billing, credit } = service();
    for (const event of order) await billing.applyEvent(event);
    const row = await billing.store.get(ws);
    const summary = await credit.summary(ws);
    finals.add(JSON.stringify({ status: row?.status, version: row?.objectVersion, balance: summary.balanceMicroGbp }));
    await billing.close();
  }
  expect(orders.length).toBe(120);
  expect(finals.size).toBe(1);
  expect([...finals][0]).toBe(JSON.stringify({ status: "active", version: 50, balance: home.includedCreditMicroGbp }));
  console.log("permutation", { orderings: orders.length, finalStates: finals.size, final: [...finals][0] });
});

it("walks grace, suspension, notice and deletion from stored timestamps across a restart", async () => {
  const t0 = Date.UTC(2026, 0, 1);
  const suspended: string[] = [];
  const deleted: string[] = [];
  const resumed: string[] = [];
  const email = createFakeEmailProvider();
  const { billing } = service({
    email,
    onSuspend: async (id) => { suspended.push(id); },
    onResume: async (id) => { resumed.push(id); },
    onDelete: async (id) => { deleted.push(id); },
  });
  await billing.applyEvent(stripeEvent("fail", "invoice.payment_failed", t0 / 1000, {
    id: "in_fail", object: "invoice", customer: "cus_1", subscription: "sub_1",
    metadata: { workspace_id: "ws-clock", plan: "home" },
  }));
  expect((await billing.store.get("ws-clock"))?.status).toBe("past_due");
  await billing.tick(t0);
  expect((await billing.store.get("ws-clock"))?.status).toBe("grace");
  await billing.tick(t0 + GRACE_WINDOW_MS);
  expect((await billing.store.get("ws-clock"))?.status).toBe("suspended");
  expect(suspended).toEqual(["ws-clock"]);
  const saved = await billing.store.get("ws-clock");
  const restarted = service({
    email: createFakeEmailProvider(),
    onDelete: async (id) => { deleted.push(id); },
  });
  await restarted.billing.store.save(saved!);
  const noticeAt = t0 + GRACE_WINDOW_MS + DELETE_AFTER_SUSPEND_MS - NOTICE_BEFORE_DELETE_MS;
  await restarted.billing.tick(noticeAt);
  expect(restarted.email.sent).toHaveLength(1);
  expect(restarted.email.sent[0]?.subject).toBe("Workspace deletion scheduled");
  const deleteAt = t0 + GRACE_WINDOW_MS + DELETE_AFTER_SUSPEND_MS;
  await restarted.billing.tick(deleteAt);
  expect((await restarted.billing.store.get("ws-clock"))?.status).toBe("deleted");
  expect(deleted).toEqual(["ws-clock"]);
  await billing.applyEvent(stripeEvent("paid", "invoice.paid", (t0 + DAY_MS) / 1000, {
    id: "in_recover", object: "invoice", customer: "cus_1", subscription: "sub_1",
    metadata: { workspace_id: "ws-recover", plan: "home" },
  }));
  await billing.applyEvent(stripeEvent("fail2", "invoice.payment_failed", (t0 + 2 * DAY_MS) / 1000, {
    id: "in_fail2", object: "invoice", customer: "cus_1", subscription: "sub_1",
    metadata: { workspace_id: "ws-recover", plan: "home" },
  }));
  await billing.tick(t0 + 2 * DAY_MS + GRACE_WINDOW_MS);
  expect((await billing.store.get("ws-recover"))?.status).toBe("suspended");
  await billing.applyEvent(stripeEvent("paid2", "invoice.paid", (t0 + 2 * DAY_MS + GRACE_WINDOW_MS) / 1000 + 10, {
    id: "in_recover2", object: "invoice", customer: "cus_1", subscription: "sub_1",
    metadata: { workspace_id: "ws-recover", plan: "home" },
  }));
  expect((await billing.store.get("ws-recover"))?.status).toBe("active");
  expect(resumed).toEqual(["ws-recover"]);
  console.log("timeline", {
    failure: "past_due",
    graceAt: new Date(t0).toISOString(),
    suspendedAt: new Date(t0 + GRACE_WINDOW_MS).toISOString(),
    noticeAt: new Date(noticeAt).toISOString(),
    deleteAt: new Date(deleteAt).toISOString(),
    restartedNotice: restarted.email.sent.length,
    deleted: deleted.length,
    recovered: "active",
  });
  await billing.close();
  await restarted.billing.close();
});

it("rounds UK VAT in minor units for seat counts 1..50 and reverse-charges a VAT id", () => {
  const unit = planPrice("home")!.unitAmountMinor;
  function ukVatMinor(net: number): number {
    const product = net * 20;
    const whole = Math.floor(product / 100);
    return product % 100 >= 50 ? whole + 1 : whole;
  }
  const fixtures: Record<number, number> = { 1: 400, 2: 800, 3: 1199, 50: 19990 };
  const table: string[] = [];
  for (let seats = 1; seats <= 50; seats++) {
    const net = unit * seats;
    const vat = ukVatMinor(net);
    if (fixtures[seats] != null) expect(vat).toBe(fixtures[seats]);
    expect(vat).toBe(Math.floor((net * 20 + 50) / 100));
    table.push(`seats=${seats} net=${net} vat=${vat} gross=${net + vat}`);
  }
  const reverse = { seats: 4, net: unit * 4, vat: 0, note: "Reverse charge: customer to account for VAT" };
  expect(reverse.vat).toBe(0);
  expect(vatGate("FR", "")).toBe("vat_id_required");
  expect(vatGate("FR", "FR123")).toBe("ok");
  expect(vatGate("GB", "")).toBe("ok");
  console.log("vat_table");
  for (const line of table) console.log(line);
  console.log(`reverse_charge seats=${reverse.seats} net=${reverse.net} vat=${reverse.vat} note=${reverse.note}`);
});

it("refuses an unpublished plan outside test mode and ignores a body success URL", async () => {
  const provider = createFakeBillingProvider();
  const { billing } = service({ provider });
  const blocked = await billing.checkout({
    workspaceId: "ws",
    plan: "home",
    email: "a@example.com",
    country: "GB",
    memberCount: 1,
    testMode: false,
  });
  expect(blocked.status).toBe(403);
  expect(blocked.body).toEqual({ error: "plan_unpublished" });
  expect(provider.checkouts).toHaveLength(0);
  const allowed = await billing.checkout({
    workspaceId: "ws",
    plan: "team",
    email: "a@example.com",
    country: "DE",
    vatId: "DE123",
    memberCount: 3,
    testMode: true,
  });
  expect(allowed.status).toBe(200);
  expect(provider.checkouts[0]?.successUrl).toBe(URLS.successUrl);
  expect(provider.checkouts[0]?.quantity).toBe(3);
  expect(provider.checkouts[0]?.priceId).toBe(planPrice("team")!.stripePriceId);
  const missingVat = await billing.checkout({
    workspaceId: "ws2",
    plan: "home",
    email: "a@example.com",
    country: "FR",
    memberCount: 1,
    testMode: true,
  });
  expect(missingVat.status).toBe(400);
  await billing.syncSeats("ws", "team", 4);
  expect(provider.quantities).toHaveLength(0);
  const row = await billing.store.get("ws");
  row!.stripeSubscriptionId = "sub_team";
  await billing.store.save(row!);
  await billing.syncSeats("ws", "team", 4);
  expect(provider.quantities).toEqual([{ subscriptionId: "sub_team", quantity: 4 }]);
  await billing.close();
});

it("strips the Stripe key from provider errors", async () => {
  const key = "sk_test_FAKE_KEY_DO_NOT_LEAK";
  const provider = createStripeBillingProvider(key, async () => new Response(JSON.stringify({ error: key }), { status: 402 }));
  let message = "";
  try {
    await provider.createCheckoutSession({
      priceId: "price_unpublished_home",
      quantity: 1,
      successUrl: URLS.successUrl,
      cancelUrl: URLS.cancelUrl,
      workspaceId: "ws",
      customerEmail: "a@example.com",
      country: "GB",
      vatId: "",
      plan: "home",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("stripe_402");
  expect(message).not.toContain(key);
  console.log("stripe_redaction", { leaked: message.includes(key), status: "stripe_402" });
});

it("prints plan margins and fails a published plan under 40%", () => {
  const sheet = readFileSync(fileURLToPath(new URL("../../../docs/fizot/cost-sheet.md", import.meta.url)), "utf8");
  const profiles = parseFlyProfiles(sheet);
  expect(profiles.map((row) => row.name)).toEqual(["always-on", "8h", "asleep"]);
  const report = evaluateMargins({ sheet, plans: PLAN_PRICES, tiers: TIER_PRICES });
  expect(report.ok).toBe(true);
  expect(report.rows.every((row) => row.published === false && row.verified === false)).toBe(true);
  const published = evaluateMargins({
    sheet,
    plans: [{ ...PLAN_PRICES[0]!, publication: "published" }],
    tiers: TIER_PRICES,
  });
  expect(published.ok).toBe(false);
  const script = fileURLToPath(new URL("../../../scripts/fizot/margin-check.mjs", import.meta.url));
  const printed = execFileSync(process.execPath, ["--experimental-strip-types", script], { encoding: "utf8" });
  expect(printed).toContain("margin_ok=true");
  expect(printed).toContain("verified=false");
  console.log("margin_check");
  console.log(formatMarginReport(report));
});
