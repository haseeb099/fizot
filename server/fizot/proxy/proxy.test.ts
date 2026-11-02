import { afterEach, describe, expect, it } from "vitest";
import { CapBook } from "./caps.ts";
import { Ledger } from "./ledger.ts";
import { assertNoSecrets, redactLogLine } from "./redact.ts";
import { startMockXai, type MockXai } from "./mock-xai.ts";
import { startFizotProxy, type FizotProxy } from "./server.ts";
import { TokenStore, isTrialShapedToken } from "./tokens.ts";

let proxy: FizotProxy | undefined;
let upstream: MockXai | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = undefined;
  upstream = undefined;
});

describe("Spike B token lifecycle (SB-U)", () => {
  it("mints a one-hour trial-shaped token, binds it, and revokes within 60 s", () => {
    const store = new TokenStore();
    const minted = store.mint({ instanceId: "inst-1", ttlSeconds: 3600 });
    expect(isTrialShapedToken(minted.token)).toBe(true);
    expect(store.authorize(minted.token, "inst-1")).toMatchObject({ instanceId: "inst-1" });
    expect(store.authorize(minted.token, "other")).toBeNull();
    const now = Date.now();
    expect(store.authorize(minted.token, "inst-1", minted.expiresAt + 1)).toBeNull();
    store.revoke(minted.id, now);
    expect(store.authorize(minted.token, "inst-1", now)).toBeNull();
  });

  it("rejects ttl above one hour by clamping", () => {
    const store = new TokenStore();
    const minted = store.mint({ instanceId: "inst-1", ttlSeconds: 10_000 }, 1_000);
    expect(minted.expiresAt).toBe(1_000 + 3600 * 1000);
  });
});

describe("Spike B ledger and caps (PL-U)", () => {
  it("records once per idempotency key", () => {
    const ledger = new Ledger();
    const first = ledger.record({ instanceId: "a", requestId: "r1", tokens: 10 });
    const second = ledger.record({ instanceId: "a", requestId: "r1", tokens: 99 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(ledger.usage("a")).toBe(10);
  });

  it("alerts at 80% and hard-stops at 100%", () => {
    const caps = new CapBook();
    caps.setLimit("a", 100);
    expect(caps.decide("a", 80, 0)).toMatchObject({ ok: true, alert: true });
    expect(caps.decide("a", 1, 100)).toMatchObject({ ok: false, status: 402 });
  });
});

describe("Spike B key redaction (SB-U)", () => {
  it("redacts bearer tokens and refuses to keep prompts", () => {
    const line = redactLogLine('Authorization: Bearer omb_ai_abcdefghijklmnopqrstuvwxyz0123456789ABCDE {"messages":[{"content":"secret prompt"}]}');
    expect(line).not.toMatch(/omb_ai_/);
    expect(line).not.toContain("secret prompt");
    assertNoSecrets(redactLogLine("Bearer omb_ai_abcdefghijklmnopqrstuvwxyz0123456789ABCDE"));
  });
});

describe("Spike B proxy stream passthrough", () => {
  it("forwards chat completions to the mock upstream with a minted token", async () => {
    upstream = await startMockXai();
    const lines: string[] = [];
    proxy = await startFizotProxy({ upstreamBase: upstream.url, log: (line) => lines.push(line) });
    const minted = await fetch(`${proxy.url}/internal/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: "inst-9", ttlSeconds: 600 }),
    }).then((r) => r.json()) as { token: string };
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        "x-request-id": "req-1",
      },
      body: JSON.stringify({ model: "mock-grok", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toContain("mock xAI");
    expect(upstream.calls.some((call) => call.path === "/v1/chat/completions")).toBe(true);
    for (const line of lines) expect(line).not.toMatch(/omb_ai_[A-Za-z0-9_-]{43}/);
  });
});
