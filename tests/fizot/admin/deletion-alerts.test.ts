import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import {
  assertAlertChannelsForProduction,
  alertChannelsConfigured,
  buildDeletionAlertPayload,
  createDeletionAlert,
  createDeletionRunner,
  createFakeFlyClient,
  createMemoryWorkspaceStore,
  createAdminServices,
  createMemoryNonceStore,
  DELETION_ALERT_12H_MS,
  DELETION_FAIL_24H_MS,
  verifyAlertSignature,
} from "../../../server/fizot/admin/public.ts";

it("production refuses to start without an alert channel", () => {
  expect(() => assertAlertChannelsForProduction({
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv)).toThrow(/alert channel/);
  expect(() => assertAlertChannelsForProduction({
    FIZOT_ENV: "production",
    FIZOT_ALERT_WEBHOOK_URL: "https://alerts.example/hook",
  } as NodeJS.ProcessEnv)).not.toThrow();
  expect(alertChannelsConfigured({
    GITHUB_TOKEN: "ghs_x",
    GITHUB_REPOSITORY: "haseeb099/fizot",
  } as NodeJS.ProcessEnv)).toBe(true);
});

it("12h / 24h / hourly alerts POST hash+steps only (no email) to the webhook", async () => {
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      received.push({
        headers: {
          "x-fizot-signature": req.headers["x-fizot-signature"],
          "x-fizot-timestamp": req.headers["x-fizot-timestamp"],
        },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const webhookUrl = `http://127.0.0.1:${addr.port}/hook`;
  const secret = "alert-secret-for-kat-tests!!!!!!";

  try {
    const fly = createFakeFlyClient();
    fly.destroyVolume = async () => {
      throw new Error("Fly DELETE volume → 500: sticky");
    };
    const store = createMemoryWorkspaceStore();
    const services = createAdminServices({
      adminUrl: "https://admin.test",
      flyOrg: "fizot",
      flyRegion: "lhr",
      machineImage: "img",
      fly,
      store,
      nonces: createMemoryNonceStore(),
    });
    const ws = await services.createWorkspace({ plan: "home", ownerEmail: "alert-owner@example.com" });

    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const alert = createDeletionAlert({
      webhookUrl,
      webhookSecret: secret,
      now: () => clock,
    });
    const runner = createDeletionRunner({
      store,
      fly,
      now: () => clock,
      sleep: async () => undefined,
      maxAttempts: 1,
      backoffMs: 0,
      alert,
    });
    await runner.requestDeletion(ws.id);
    await runner.runOnce(ws.id);

    clock += DELETION_ALERT_12H_MS + 1000;
    await runner.runOnce(ws.id);
    clock += DELETION_FAIL_24H_MS - DELETION_ALERT_12H_MS;
    await runner.runOnce(ws.id);
    clock += 60 * 60_000 + 1000;
    await runner.runOnce(ws.id);

    expect(received.length).toBeGreaterThanOrEqual(3);
    const kinds = received.map((r) => (JSON.parse(r.body) as { kind: string }).kind);
    expect(kinds).toContain("12h");
    expect(kinds).toContain("24h");
    expect(kinds).toContain("hourly");

    for (const row of received) {
      const payload = JSON.parse(row.body) as Record<string, unknown>;
      expect(payload.workspaceIdHash).toMatch(/^[a-f0-9]{64}$/);
      expect(payload).toHaveProperty("stepsDone");
      expect(JSON.stringify(payload)).not.toMatch(/alert-owner@example\.com/i);
      expect(JSON.stringify(payload)).not.toMatch(/@/);
      const ts = String(row.headers["x-fizot-timestamp"] ?? "");
      const sig = String(row.headers["x-fizot-signature"] ?? "");
      expect(verifyAlertSignature({ secret, timestamp: ts, body: row.body, signature: sig })).toBe(true);
    }

    const sample = buildDeletionAlertPayload({
      workspaceIdHash: "abc",
      kind: "12h",
      message: "x",
      receipt: (await store.getDeletionReceipt(ws.id))!,
    });
    expect(JSON.stringify(sample)).not.toMatch(/email/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
