import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { signStripeHeader } from "../../../server/fizot/admin/webhooks.ts";
import { createAdminServer } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";
import { planPrice } from "../../../server/fizot/billing/plan-prices.ts";
import { GRACE_WINDOW_MS } from "../../../server/fizot/billing/record.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL?.trim();

it.runIf(Boolean(databaseUrl))("Postgres webhook dedupe, grant idempotency and grace transition", async () => {
  process.env.FIZOT_WEBHOOK_STRIPE_SECRET = "whsec_test_billing";
  const admin = await createAdminServer({ port: 0, cookieSecure: false });
  try {
    const sign = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bill@example.com" }),
    });
    const cookie = (sign.headers.getSetCookie?.() ?? []).find((row) => row.startsWith(`${SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
    const created = await fetch(`${admin.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ plan: "home", ownerEmail: "bill@example.com" }),
    });
    const workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const invoiceId = `in_${randomUUID()}`;
    const body = JSON.stringify({
      id: `evt_${invoiceId}`,
      type: "invoice.paid",
      created: 1_700_000_000,
      data: { object: { id: invoiceId, object: "invoice", customer: "cus_pg", metadata: { workspace_id: workspaceId, plan: "home" } } },
    });
    const header = signStripeHeader("whsec_test_billing", body, Math.floor(Date.now() / 1000));
    const posts = await Promise.all([0, 1].map(() => fetch(`${admin.url}/admin/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body,
    })));
    const payloads = await Promise.all(posts.map(async (res) => ({ status: res.status, body: await res.json() as { duplicate?: boolean } })));
    expect(payloads.every((row) => row.status === 200)).toBe(true);
    expect(payloads.filter((row) => row.body.duplicate).length).toBe(1);
    const summary = await admin.credit.summary(workspaceId);
    expect(summary.balanceMicroGbp).toBe(planPrice("home")!.includedCreditMicroGbp);
    const again = await fetch(`${admin.url}/admin/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signStripeHeader("whsec_test_billing", body, Math.floor(Date.now() / 1000)) },
      body,
    });
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect((await admin.credit.summary(workspaceId)).balanceMicroGbp).toBe(summary.balanceMicroGbp);
    const t0 = Date.UTC(2026, 3, 1);
    const failed = JSON.stringify({
      id: `evt_fail_${workspaceId}`,
      type: "invoice.payment_failed",
      created: t0 / 1000,
      data: { object: { id: "in_fail", object: "invoice", customer: "cus_pg", subscription: "sub_pg", metadata: { workspace_id: workspaceId, plan: "home" } } },
    });
    const failedRes = await fetch(`${admin.url}/admin/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signStripeHeader("whsec_test_billing", failed, Math.floor(Date.now() / 1000)) },
      body: failed,
    });
    expect(failedRes.status).toBe(200);
    expect((await admin.billing.store.get(workspaceId))?.status).toBe("past_due");
    await admin.billing.tick(t0);
    expect((await admin.billing.store.get(workspaceId))?.status).toBe("grace");
    await admin.billing.tick(t0 + GRACE_WINDOW_MS);
    expect((await admin.billing.store.get(workspaceId))?.status).toBe("suspended");
    console.log("postgres_billing", {
      duplicate: 1,
      balanceMicroGbp: summary.balanceMicroGbp,
      afterGrace: "grace",
      afterWindow: "suspended",
    });
  } finally {
    await admin.close();
  }
});
