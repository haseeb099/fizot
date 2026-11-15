import { expect, it } from "vitest";
import { RESERVATION_RECOVERY_GRACE_MS } from "../../../server/fizot/proxy/credit-policy.ts";
import { createMemoryCreditStore } from "../../../server/fizot/proxy/credit-store.ts";
import { meterCompletion } from "../../../server/fizot/proxy/meter.ts";
import type { TierPrice } from "../../../server/fizot/proxy/pricing.ts";

const TEST_SECRET = "fizot-test-hmac-p43-not-production-only-0123456789";
const FP = "a".repeat(64);

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

async function seed(balance: number) {
  const credit = createMemoryCreditStore();
  await credit.ensureAccount("ws", balance);
  await credit.grant({ workspaceId: "ws", amountMicroGbp: balance, requestId: "grant-1", kind: "grant" });
  return credit;
}

it("two simultaneous requests compete for the last credit unit", async () => {
  const credit = await seed(1);
  let started = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const run = (requestId: string) => meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit,
    workspaceId: "ws",
    requestId,
    tier: "fast",
    rawBody: Buffer.from("{}"),
    parsed: { max_tokens: 1 },
    prices: UNIT,
    forward: async () => {
      started += 1;
      await gate;
      return { status: 200, contentType: "application/json", body: completion(1) };
    },
  });
  const first = run("race-a");
  const second = run("race-b");
  await new Promise((r) => setTimeout(r, 20));
  releaseGate();
  const results = await Promise.all([first, second]);
  const ok = results.filter((row) => row.status === 200).length;
  const denied = results.filter((row) => row.status === 402).length;
  expect(ok).toBe(1);
  expect(denied).toBe(1);
  expect(started).toBe(1);
  expect(await credit.settledMicroGbp("ws")).toBe(1);
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(0);
});

it("fifty parallel requests cannot overspend a balance of 10", async () => {
  const credit = await seed(10);
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit,
    workspaceId: "ws",
    requestId: `r-${index}`,
    tier: "fast",
    rawBody: Buffer.from("{}"),
    parsed: { max_tokens: 1 },
    prices: UNIT,
    forward: async () => ({
      status: 200,
      contentType: "application/json",
      body: completion(1),
    }),
  })));
  expect(results.filter((row) => row.status === 200)).toHaveLength(10);
  expect(results.filter((row) => row.status === 402)).toHaveLength(40);
  expect(await credit.settledMicroGbp("ws")).toBe(10);
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(0);
});

it("caps actual provider usage that exceeds the reserved estimate", async () => {
  const credit = await seed(5);
  const reserved = await credit.tryReserve({
    workspaceId: "ws",
    requestId: "over",
    amountMicroGbp: 2,
    requestFingerprint: FP,
  });
  expect(reserved.ok).toBe(true);
  const settled = await credit.settle({
    workspaceId: "ws",
    requestId: "over",
    amountMicroGbp: 9,
    provider: "xai",
    model: "internal-fast",
    tier: "fast",
    inputTokens: 0,
    outputTokens: 9,
    httpStatus: 200,
    meta: { prompt: "secret-prompt", response: "secret-completion" },
  });
  expect(settled.amountMicroGbp).toBe(-2);
  expect(settled.meta.cappedToReservation).toBe(true);
  expect(settled.meta.prompt).toBeUndefined();
  expect(settled.meta.response).toBeUndefined();
  expect(await credit.settledMicroGbp("ws")).toBe(2);
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(3);
});

it("rejects invalid and oversized max_tokens before reserve", async () => {
  const credit = await seed(10);
  const invalid = await meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit, workspaceId: "ws", requestId: "bad-max", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: -5 }, prices: UNIT,
    forward: async () => ({ status: 200, contentType: "application/json", body: completion(1) }),
  });
  expect(invalid.status).toBe(400);
  expect(JSON.parse(invalid.body)).toEqual({ error: "invalid_max_tokens" });
  const oversized = await meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit, workspaceId: "ws", requestId: "big-max", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 200_000 }, prices: UNIT,
    forward: async () => ({ status: 200, contentType: "application/json", body: completion(1) }),
  });
  expect(oversized.status).toBe(400);
  expect(JSON.parse(oversized.body)).toEqual({ error: "max_tokens_too_large" });
  expect((await credit.summary("ws")).reservedMicroGbp).toBe(0);
});

it("timeouts mark uncertain; recovery quarantines without fabricating usage", async () => {
  const credit = await seed(10);
  const now = Date.UTC(2025, 0, 1, 12, 0, 0);
  const timedOut = await meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit, workspaceId: "ws", requestId: "timeout-1", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 3 }, prices: UNIT, now,
    forward: async () => {
      throw new Error("provider timed out waiting for response");
    },
  });
  expect(timedOut.status).toBe(504);
  expect((await credit.summary("ws")).reservedMicroGbp).toBe(3);
  expect(await credit.usageCount("ws")).toBe(0);

  const early = await credit.recoverStaleReservations({
    workspaceId: "ws",
    nowMs: now + RESERVATION_RECOVERY_GRACE_MS - 1,
    graceMs: RESERVATION_RECOVERY_GRACE_MS,
  });
  expect(early.released + early.quarantined).toBe(0);

  const recovered = await credit.recoverStaleReservations({
    workspaceId: "ws",
    nowMs: Date.now() + RESERVATION_RECOVERY_GRACE_MS + 1,
    graceMs: RESERVATION_RECOVERY_GRACE_MS,
  });
  expect(recovered.quarantined).toBe(1);
  expect(recovered.released).toBe(0);
  expect(await credit.usageCount("ws")).toBe(0);
  expect(await credit.settledMicroGbp("ws")).toBe(0);
  expect((await credit.summary("ws")).reservedMicroGbp).toBe(3);

  const late = await credit.settle({
    workspaceId: "ws", requestId: "timeout-1", amountMicroGbp: 2,
    provider: "xai", model: "internal-fast", tier: "fast",
    inputTokens: 0, outputTokens: 2, httpStatus: 200,
  });
  expect(late.amountMicroGbp).toBe(-2);
  expect(await credit.usageCount("ws")).toBe(1);
  expect((await credit.summary("ws")).reservedMicroGbp).toBe(0);
});

it("crash after reserve before dispatch releases without usage charge", async () => {
  const credit = await seed(10);
  const now = Date.UTC(2025, 2, 1);
  const reserved = await credit.tryReserve({
    workspaceId: "ws", requestId: "crash-1", amountMicroGbp: 4, requestFingerprint: FP, nowMs: now,
  });
  expect(reserved.ok).toBe(true);
  const tooSoon = await credit.recoverStaleReservations({
    workspaceId: "ws", nowMs: now + RESERVATION_RECOVERY_GRACE_MS - 1, graceMs: RESERVATION_RECOVERY_GRACE_MS,
  });
  expect(tooSoon.released).toBe(0);
  const recovered = await credit.recoverStaleReservations({
    workspaceId: "ws", nowMs: now + RESERVATION_RECOVERY_GRACE_MS + 1, graceMs: RESERVATION_RECOVERY_GRACE_MS,
  });
  expect(recovered.released).toBe(1);
  expect(recovered.quarantined).toBe(0);
  expect(await credit.usageCount("ws")).toBe(0);
  expect((await credit.summary("ws", now + RESERVATION_RECOVERY_GRACE_MS + 1)).reservedMicroGbp).toBe(0);
  expect((await credit.summary("ws", now + RESERVATION_RECOVERY_GRACE_MS + 1)).balanceMicroGbp).toBe(10);
});

it("long-running dispatched request is quarantined, not settled, after grace", async () => {
  const credit = await seed(10);
  const now = Date.UTC(2025, 3, 1);
  await credit.tryReserve({
    workspaceId: "ws", requestId: "long-1", amountMicroGbp: 5, requestFingerprint: FP, nowMs: now,
  });
  await credit.markDispatched("ws", "long-1", now);
  const recovered = await credit.recoverStaleReservations({
    workspaceId: "ws", nowMs: now + RESERVATION_RECOVERY_GRACE_MS + 1, graceMs: RESERVATION_RECOVERY_GRACE_MS,
  });
  expect(recovered.quarantined).toBe(1);
  expect(await credit.usageCount("ws")).toBe(0);
  expect((await credit.summary("ws")).reservedMicroGbp).toBe(5);
});

it("rejects negative, zero and unsafe-integer grant/refund amounts", async () => {
  const credit = createMemoryCreditStore();
  await credit.ensureAccount("ws", 10);
  await expect(credit.grant({ workspaceId: "ws", amountMicroGbp: -5, requestId: "neg", kind: "grant" }))
    .rejects.toThrow(/positive/);
  await expect(credit.grant({ workspaceId: "ws", amountMicroGbp: 0, requestId: "zero", kind: "refund" }))
    .rejects.toThrow(/positive/);
  await expect(credit.grant({ workspaceId: "ws", amountMicroGbp: Number.MAX_SAFE_INTEGER + 1, requestId: "big" }))
    .rejects.toThrow(/safe integer/);
  await expect(credit.grant({ workspaceId: "ws", amountMicroGbp: 0, requestId: "adj0", kind: "adjust" }))
    .rejects.toThrow(/non-zero/);
  await credit.grant({ workspaceId: "ws", amountMicroGbp: 10, requestId: "ok" });
  await credit.grant({ workspaceId: "ws", amountMicroGbp: -3, requestId: "adj-neg", kind: "adjust" });
  expect((await credit.summary("ws")).balanceMicroGbp).toBe(7);
  await expect(credit.grant({ workspaceId: "ws", amountMicroGbp: 9, requestId: "ok" }))
    .rejects.toThrow("grant_idempotency_conflict");
});

it("expired lot plus later usage does not inflate spendable balance", async () => {
  const credit = createMemoryCreditStore();
  await credit.ensureAccount("ws", 20);
  await credit.grant({
    workspaceId: "ws", amountMicroGbp: 10, requestId: "g_old", kind: "grant",
    nowMs: Date.UTC(2024, 0, 1),
  });
  await credit.grant({
    workspaceId: "ws", amountMicroGbp: 10, requestId: "g_new", kind: "grant",
    nowMs: Date.UTC(2025, 0, 1),
  });
  const expireAt = Date.UTC(2025, 0, 1);
  expect((await credit.summary("ws", expireAt)).balanceMicroGbp).toBe(10);
  await credit.tryReserve({
    workspaceId: "ws", requestId: "u_later", amountMicroGbp: 7, requestFingerprint: FP,
    nowMs: Date.UTC(2025, 0, 2),
  });
  await credit.settle({
    workspaceId: "ws", requestId: "u_later", amountMicroGbp: 7,
    provider: "xai", model: "internal-fast", tier: "fast",
    inputTokens: 0, outputTokens: 7, httpStatus: 200, nowMs: Date.UTC(2025, 0, 2),
  });
  expect((await credit.summary("ws", Date.UTC(2025, 0, 3))).balanceMicroGbp).toBe(3);
  expect(await credit.expireDue("ws", Date.UTC(2025, 0, 3))).toBeGreaterThanOrEqual(0);
  expect((await credit.summary("ws", Date.UTC(2025, 0, 3))).balanceMicroGbp).toBe(3);
});

it("releases unused reservation after definite provider failure", async () => {
  const credit = await seed(10);
  const failed = await meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit, workspaceId: "ws", requestId: "fail-1", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 2 }, prices: UNIT,
    forward: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  expect(failed.status).toBe(502);
  expect((await credit.summary("ws")).reservedMicroGbp).toBe(0);
  expect(await credit.usageCount("ws")).toBe(0);
});

it("repeated settlement of the same request id is idempotent", async () => {
  const credit = await seed(10);
  await credit.tryReserve({
    workspaceId: "ws", requestId: "settle-once", amountMicroGbp: 4, requestFingerprint: FP,
  });
  const first = await credit.settle({
    workspaceId: "ws", requestId: "settle-once", amountMicroGbp: 4,
    provider: "xai", model: "internal-fast", tier: "fast",
    inputTokens: 0, outputTokens: 4, httpStatus: 200,
  });
  const second = await credit.settle({
    workspaceId: "ws", requestId: "settle-once", amountMicroGbp: 4,
    provider: "xai", model: "internal-fast", tier: "fast",
    inputTokens: 0, outputTokens: 4, httpStatus: 200,
  });
  expect(second.id).toBe(first.id);
  expect(await credit.usageCount("ws")).toBe(1);
  expect(await credit.settledMicroGbp("ws")).toBe(4);
});

it("expires grants at the 12-month boundary without mutating grant rows", async () => {
  const credit = createMemoryCreditStore();
  const grantedAt = Date.UTC(2024, 0, 15, 10, 0, 0);
  await credit.ensureAccount("ws", 100);
  const grant = await credit.grant({
    workspaceId: "ws",
    amountMicroGbp: 100,
    requestId: "grant-expire",
    kind: "grant",
    nowMs: grantedAt,
  });
  expect(grant.expiresAt).toBe(new Date(Date.UTC(2025, 0, 15, 10, 0, 0)).toISOString());
  const before = await credit.summary("ws", Date.UTC(2025, 0, 15, 9, 59, 59));
  expect(before.balanceMicroGbp).toBe(100);
  const at = await credit.summary("ws", Date.UTC(2025, 0, 15, 10, 0, 0));
  expect(at.balanceMicroGbp).toBe(0);
  expect(await credit.expireDue("ws", Date.UTC(2025, 0, 15, 10, 0, 0))).toBe(0);
  const after = await credit.summary("ws", Date.UTC(2025, 0, 16));
  expect(after.balanceMicroGbp).toBe(0);
  const reserved = await credit.tryReserve({
    workspaceId: "ws",
    requestId: "post-expire",
    amountMicroGbp: 1,
    requestFingerprint: FP,
    nowMs: Date.UTC(2025, 0, 16),
  });
  expect(reserved).toEqual({ ok: false, reason: "insufficient" });
});

it("legacy null-expiry grants coexist with new expiring grants", async () => {
  const credit = createMemoryCreditStore();
  const now = Date.UTC(2024, 5, 1);
  await credit.ensureAccount("ws", 50);
  await credit.grant({
    workspaceId: "ws", amountMicroGbp: 40, requestId: "legacy", kind: "grant",
    nowMs: now, expireInTwelveMonths: false,
  });
  await credit.grant({
    workspaceId: "ws", amountMicroGbp: 10, requestId: "fresh", kind: "grant", nowMs: now,
  });
  const mid = await credit.summary("ws", Date.UTC(2025, 5, 1));
  expect(mid.balanceMicroGbp).toBe(40);
  const reserved = await credit.tryReserve({
    workspaceId: "ws", requestId: "use-legacy", amountMicroGbp: 40, requestFingerprint: FP,
    nowMs: Date.UTC(2025, 5, 1),
  });
  expect(reserved.ok).toBe(true);
});

it("concurrent expireDue workers remain idempotent", async () => {
  const credit = createMemoryCreditStore();
  const grantedAt = Date.UTC(2023, 0, 1);
  await credit.ensureAccount("ws", 20);
  await credit.grant({
    workspaceId: "ws", amountMicroGbp: 20, requestId: "g-concurrent", kind: "grant", nowMs: grantedAt,
  });
  const now = Date.UTC(2024, 0, 1);
  const results = await Promise.all([
    credit.expireDue("ws", now),
    credit.expireDue("ws", now),
    credit.expireDue("ws", now),
  ]);
  expect(results.reduce((a, b) => a + b, 0)).toBe(1);
  expect((await credit.summary("ws", now)).balanceMicroGbp).toBe(0);
});

it("complete request journey reconciles balance after settle", async () => {
  const credit = await seed(25);
  const outcome = await meterCompletion({
    idempotencySecret: TEST_SECRET,
    credit, workspaceId: "ws", requestId: "journey-1", tier: "fast",
    rawBody: Buffer.from("{}"), parsed: { max_tokens: 8 }, prices: UNIT,
    forward: async () => ({ status: 200, contentType: "application/json", body: completion(5, "journey-ok") }),
  });
  expect(outcome.status).toBe(200);
  expect(outcome.body).toContain("journey-ok");
  const summary = await credit.summary("ws");
  expect(summary.balanceMicroGbp).toBe(20);
  expect(summary.reservedMicroGbp).toBe(0);
  expect(await credit.settledMicroGbp("ws")).toBe(5);
});
