import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createMemoryCreditStore } from "../../../server/fizot/proxy/credit-store.ts";
import {
  createRateLimiter,
  meterCompletion,
  type SoftAlertEvent,
} from "../../../server/fizot/proxy/meter.ts";
import type { TierPrice } from "../../../server/fizot/proxy/pricing.ts";
import { redactSecrets } from "../../../server/fizot/proxy/redact.ts";
import { startMockXai } from "../../../server/fizot/proxy/mock-xai.ts";
import { startFizotProxy } from "../../../server/fizot/proxy/server.ts";

const UNIT: TierPrice[] = [{
  tier: "fast",
  displayName: "Fast",
  provider: "xai",
  model: "internal-fast",
  priceStatus: "placeholder_unverified",
  inputMicroGbpPerMillion: 0,
  outputMicroGbpPerMillion: 1_000_000,
  markupBps: 0,
}];

function completion(outputTokens: number, content = "ok"): Buffer {
  return Buffer.from(JSON.stringify({
    model: "internal-fast",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 0, completion_tokens: outputTokens },
  }));
}

async function seed(balance: number, included = balance) {
  const credit = createMemoryCreditStore();
  await credit.ensureAccount("ws", included);
  await credit.grant({ workspaceId: "ws", amountMicroGbp: balance, requestId: "grant-1", kind: "grant" });
  return credit;
}

it("reserves then settles the provider usage, and a repeat request_id does not charge again", async () => {
  const credit = await seed(10);
  let calls = 0;
  const once = await meterCompletion({
    credit,
    workspaceId: "ws",
    requestId: "req-1",
    tier: "fast",
    rawBody: Buffer.from("{}"),
    parsed: { max_tokens: 1 },
    prices: UNIT,
    forward: async () => {
      calls += 1;
      return { status: 200, contentType: "application/json", body: completion(1, "stored-answer") };
    },
  });
  const again = await meterCompletion({
    credit,
    workspaceId: "ws",
    requestId: "req-1",
    tier: "fast",
    rawBody: Buffer.from("{}"),
    parsed: { max_tokens: 1 },
    prices: UNIT,
    forward: async () => {
      calls += 1;
      return { status: 200, contentType: "application/json", body: completion(1, "other") };
    },
  });
  expect(once.status).toBe(200);
  expect(again.body).toBe(once.body);
  expect(again.body).toContain("stored-answer");
  expect(again.body).not.toContain("internal-fast");
  expect(calls).toBe(1);
  expect(await credit.usageCount("ws")).toBe(1);
  expect(await credit.settledMicroGbp("ws")).toBe(1);
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(9);
  console.log("idempotency", {
    calls,
    usageRows: await credit.usageCount("ws"),
    settledMicroGbp: await credit.settledMicroGbp("ws"),
    balanceMicroGbp: (await credit.summary("ws")).balanceMicroGbp,
    replayStatus: again.status,
  });
});

it("returns 409 while the same request_id is in flight", async () => {
  const credit = await seed(10);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started: () => void = () => {};
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const first = meterCompletion({
    credit,
    workspaceId: "ws",
    requestId: "req-fly",
    tier: "fast",
    rawBody: Buffer.from("{}"),
    parsed: { max_tokens: 1 },
    prices: UNIT,
    forward: async () => {
      started();
      await gate;
      return { status: 200, contentType: "application/json", body: completion(1) };
    },
  });
  await startedP;
  const second = await meterCompletion({
    credit,
    workspaceId: "ws",
    requestId: "req-fly",
    tier: "fast",
    rawBody: Buffer.from("{}"),
    parsed: { max_tokens: 1 },
    prices: UNIT,
    forward: async () => ({ status: 200, contentType: "application/json", body: completion(1) }),
  });
  expect(second.status).toBe(409);
  expect(JSON.parse(second.body)).toEqual({ error: "in_flight", request_id: "req-fly" });
  release();
  expect((await first).status).toBe(200);
  expect(await credit.usageCount("ws")).toBe(1);
  console.log("idempotency_in_flight", { secondStatus: second.status, usageRows: await credit.usageCount("ws") });
});

it("alerts at exactly 80% once and hard-stops at 100% without forwarding", async () => {
  const credit = await seed(100, 100);
  const alerts: SoftAlertEvent[] = [];
  let calls = 0;
  const forward = async () => {
    calls += 1;
    return { status: 200, contentType: "application/json", body: completion(1) };
  };
  const eighty = UNIT.map((row) => ({ ...row, outputMicroGbpPerMillion: 80_000_000 }));
  const first = await meterCompletion({
    credit, workspaceId: "ws", requestId: "r80", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 1 }, prices: eighty,
    onSoftAlert: async (event) => { alerts.push(event); },
    forward,
  });
  expect(first.status).toBe(200);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.usageMicroGbp).toBe(80);
  expect(alerts[0]?.workspaceIdHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(alerts[0])).not.toMatch(/@/);
  const second = await meterCompletion({
    credit, workspaceId: "ws", requestId: "r20", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 1 }, prices: UNIT.map((row) => ({ ...row, outputMicroGbpPerMillion: 20_000_000 })),
    onSoftAlert: async (event) => { alerts.push(event); },
    forward,
  });
  expect(second.status).toBe(200);
  expect(alerts).toHaveLength(1);
  const blocked = await meterCompletion({
    credit, workspaceId: "ws", requestId: "r1", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 1 }, prices: UNIT,
    forward,
  });
  expect(blocked.status).toBe(402);
  expect(JSON.parse(blocked.body)).toEqual({ error: "insufficient_credit" });
  expect(calls).toBe(2);
  const summary = await credit.summary("ws");
  console.log("cap_80_100", {
    alertCount: alerts.length,
    usageAtAlert: alerts[0]?.usageMicroGbp,
    included: alerts[0]?.includedMicroGbp,
    balanceMicroGbp: summary.balanceMicroGbp,
    periodUsageMicroGbp: summary.periodUsageMicroGbp,
    forwarded: calls,
    blockedStatus: blocked.status,
  });
});

it("allows a charge that lands on exactly 100% and refuses the next one", async () => {
  const credit = await seed(100, 100);
  let calls = 0;
  const full = UNIT.map((row) => ({ ...row, outputMicroGbpPerMillion: 100_000_000 }));
  const ok = await meterCompletion({
    credit, workspaceId: "ws", requestId: "all", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 1 }, prices: full,
    forward: async () => {
      calls += 1;
      return { status: 200, contentType: "application/json", body: completion(1) };
    },
  });
  expect(ok.status).toBe(200);
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(0);
  const denied = await meterCompletion({
    credit, workspaceId: "ws", requestId: "more", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 1 }, prices: UNIT,
    forward: async () => {
      calls += 1;
      return { status: 200, contentType: "application/json", body: completion(1) };
    },
  });
  expect(denied.status).toBe(402);
  expect(calls).toBe(1);
});

it("releases the reservation when the provider returns 500 and when usage is missing charges the reserve", async () => {
  const credit = await seed(10);
  const failed = await meterCompletion({
    credit, workspaceId: "ws", requestId: "boom", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 1 }, prices: UNIT,
    forward: async () => ({ status: 500, contentType: "application/json", body: Buffer.from("{\"error\":\"down\"}") }),
  });
  expect(failed.status).toBe(500);
  expect(await credit.usageCount("ws")).toBe(0);
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(10);
  const missing = await meterCompletion({
    credit, workspaceId: "ws", requestId: "nousage", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 4 }, prices: UNIT,
    forward: async () => ({ status: 200, contentType: "application/json", body: Buffer.from("{\"choices\":[]}") }),
  });
  expect(missing.status).toBe(200);
  expect(await credit.settledMicroGbp("ws")).toBe(4);
});

it("streams a mock completion, strips the provider key, and the kill switch forwards nothing", async () => {
  const fakeKey = "xai-fake-key-DO-NOT-LEAK";
  const credit = await seed(1_000_000);
  const upstream = await startMockXai();
  const lines: string[] = [];
  const alerts: SoftAlertEvent[] = [];
  const proxy = await startFizotProxy({
    upstreamBase: upstream.url,
    upstreamKey: fakeKey,
    credit,
    tokens: undefined,
    prices: UNIT,
    log: (line) => lines.push(line),
    onSoftAlert: async (event) => { alerts.push(event); },
  });
  try {
    const minted = await fetch(`${proxy.url}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "ws", ttlSeconds: 600 }),
    }).then((r) => r.json()) as { token: string };
    const streamed = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        "x-request-id": "stream-1",
      },
      body: JSON.stringify({ tier: "fast", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain("hello");
    expect(text).not.toContain("internal-fast");
    expect(text).not.toContain(fakeKey);
    expect(await credit.usageCount("ws")).toBe(1);

    await credit.setDisabled(true);
    const killed = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        "x-request-id": "stream-2",
      },
      body: JSON.stringify({ tier: "fast", max_tokens: 1 }),
    });
    expect(killed.status).toBe(503);
    expect(upstream.calls.filter((call) => call.path === "/v1/chat/completions")).toHaveLength(1);
    for (const line of lines) {
      expect(line).not.toContain(fakeKey);
      assertNoKey(line, fakeKey);
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }

  const failing = await startMockXai({
    failStatus: 500,
    failBody: JSON.stringify({ error: { message: `leaked ${fakeKey}` } }),
  });
  const credit2 = await seed(100);
  const proxy2 = await startFizotProxy({
    upstreamBase: failing.url,
    upstreamKey: fakeKey,
    credit: credit2,
    prices: UNIT,
    log: (line) => lines.push(line),
  });
  try {
    const minted = await fetch(`${proxy2.url}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "ws", ttlSeconds: 600 }),
    }).then((r) => r.json()) as { token: string };
    const failed = await fetch(`${proxy2.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        "x-request-id": "fail-1",
      },
      body: JSON.stringify({ tier: "fast", max_tokens: 1 }),
    });
    const body = await failed.text();
    expect(failed.status).toBe(500);
    expect(body).not.toContain(fakeKey);
    expect(await credit2.usageCount("ws")).toBe(0);
    expect(redactSecrets(`Bearer ${fakeKey} prompt`, [fakeKey])).not.toContain(fakeKey);
  } finally {
    await proxy2.close();
    await failing.close();
  }
});

it("delivers the 80% alert on the webhook with hash and amounts only", async () => {
  const received: string[] = [];
  const hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", () => resolve()));
  const address = hook.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const prevUrl = process.env.FIZOT_ALERT_WEBHOOK_URL;
  const prevSecret = process.env.FIZOT_ALERT_WEBHOOK_SECRET;
  process.env.FIZOT_ALERT_WEBHOOK_URL = `http://127.0.0.1:${address.port}/hook`;
  process.env.FIZOT_ALERT_WEBHOOK_SECRET = "alert-secret-for-credit-tests";
  const credit = await seed(600, 600);
  const upstream = await startMockXai();
  const proxy = await startFizotProxy({
    upstreamBase: upstream.url,
    credit,
    prices: UNIT.map((row) => ({ ...row, outputMicroGbpPerMillion: 80_000_000 })),
  });
  try {
    const minted = await fetch(`${proxy.url}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "ws", ttlSeconds: 600 }),
    }).then((r) => r.json()) as { token: string };
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        "x-request-id": "alert-1",
      },
      body: JSON.stringify({ tier: "fast", max_tokens: 6 }),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]!) as { kind: string; workspaceIdHash: string; usageMicroGbp: number };
    expect(payload.kind).toBe("credit_soft_80");
    expect(payload.usageMicroGbp).toBe(480);
    expect(payload.workspaceIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(received[0]).not.toMatch(/@|prompt|messages/);
    console.log("alert_webhook", payload);
  } finally {
    if (prevUrl === undefined) delete process.env.FIZOT_ALERT_WEBHOOK_URL;
    else process.env.FIZOT_ALERT_WEBHOOK_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.FIZOT_ALERT_WEBHOOK_SECRET;
    else process.env.FIZOT_ALERT_WEBHOOK_SECRET = prevSecret;
    await proxy.close();
    await upstream.close();
    await new Promise<void>((resolve) => hook.close(() => resolve()));
  }
});

it("rate-limits a workspace per minute", () => {
  const limiter = createRateLimiter(2);
  expect(limiter.allow("ws", 1_000)).toBe(true);
  expect(limiter.allow("ws", 1_000)).toBe(true);
  expect(limiter.allow("ws", 1_000)).toBe(false);
  expect(limiter.allow("ws", 61_000)).toBe(true);
});

function assertNoKey(line: string, key: string): void {
  expect(line.includes(key)).toBe(false);
}
