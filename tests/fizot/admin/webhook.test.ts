import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createMemoryWebhookEventStore,
  deliverWebhookEvent,
  publicRouteIds,
  ROUTE_REGISTRY,
  signGenericHmac,
  signStripeHeader,
  verifyHmacSha256,
  verifyStripeSignature,
  createFakeFlyClient,
  createMemoryNonceStore,
} from "../../../server/fizot/admin/public.ts";
import { createAdminServer, FakeAuthProvider } from "../../../server/fizot/admin/index.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts/fizot/independent-webhook-kat.mjs");

it("webhook KAT matches independent node:crypto vectors (generic + stripe)", () => {
  const ran = spawnSync(process.execPath, [SCRIPT, "--json"], { encoding: "utf8" });
  expect(ran.status, ran.stderr || ran.stdout).toBe(0);
  const vector = JSON.parse(ran.stdout) as {
    generic: { secret: string; body: string; timestamp: string; signature: string };
    stripe: { secret: string; body: string; timestamp: string; header: string };
  };

  expect(signGenericHmac(vector.generic.secret, vector.generic.body, vector.generic.timestamp))
    .toBe(vector.generic.signature);
  expect(verifyHmacSha256({
    secret: vector.generic.secret,
    body: vector.generic.body,
    signature: vector.generic.signature,
    timestamp: vector.generic.timestamp,
    now: () => Number(vector.generic.timestamp) * 1000,
  }).ok).toBe(true);

  expect(signStripeHeader(vector.stripe.secret, vector.stripe.body, Number(vector.stripe.timestamp)))
    .toBe(vector.stripe.header);
  expect(verifyStripeSignature({
    secret: vector.stripe.secret,
    body: vector.stripe.body,
    header: vector.stripe.header,
    now: () => Number(vector.stripe.timestamp) * 1000,
  }).ok).toBe(true);

  console.log("webhook_kat_ok", {
    genericSig: vector.generic.signature.slice(0, 16),
    stripeHeader: vector.stripe.header.slice(0, 24),
  });
});

it("ROUTE_REGISTRY lists admin.webhook as public; unsigned call never reaches handler success", async () => {
  expect(publicRouteIds()).toContain("admin.webhook");
  const def = ROUTE_REGISTRY.find((r) => r.id === "admin.webhook")!;
  expect(def.auth).toBe("public");

  process.env.FIZOT_WEBHOOK_GENERIC_SECRET = "test-secret-for-tc36-webhook!!!!";
  const admin = await createAdminServer({
    fly: createFakeFlyClient(),
    auth: new FakeAuthProvider(),
    cookieSecure: false,
    nonces: createMemoryNonceStore(),
  });
  try {
    const unsigned = await fetch(`${admin.url}/admin/webhooks/generic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_1", type: "test" }),
    });
    expect(unsigned.status).toBe(401);

    const bad = await fetch(`${admin.url}/admin/webhooks/generic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fizot-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-fizot-signature": "deadbeef",
      },
      body: JSON.stringify({ id: "evt_2", type: "test" }),
    });
    expect(bad.status).toBe(401);

    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ id: "evt_ok", type: "test.ok" });
    const sig = signGenericHmac(process.env.FIZOT_WEBHOOK_GENERIC_SECRET, body, ts);
    const ok = await fetch(`${admin.url}/admin/webhooks/generic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fizot-timestamp": ts,
        "x-fizot-signature": sig,
      },
      body,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { duplicate: boolean }).duplicate).toBe(false);
  } finally {
    await admin.close();
    delete process.env.FIZOT_WEBHOOK_GENERIC_SECRET;
  }
});

it("webhook dedupe: concurrent dual delivery yields exactly one handler run", async () => {
  const store = createMemoryWebhookEventStore();
  let runs = 0;
  const handler = async () => {
    runs += 1;
    return { runs };
  };
  const [a, b] = await Promise.all([
    deliverWebhookEvent({ store, provider: "generic", eventId: "evt_race", handler }),
    deliverWebhookEvent({ store, provider: "generic", eventId: "evt_race", handler }),
  ]);
  const delivered = [a, b].filter((r) => r.delivered);
  const dupes = [a, b].filter((r) => !r.delivered);
  expect(delivered).toHaveLength(1);
  expect(dupes).toHaveLength(1);
  expect(runs).toBe(1);
  console.log("webhook_concurrency", { delivered: delivered.length, dupes: dupes.length, runs });
});
