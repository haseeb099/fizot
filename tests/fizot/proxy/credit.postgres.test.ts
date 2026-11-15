import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPostgresCreditStore } from "../../../server/fizot/proxy/credit-store.ts";
import { meterCompletion } from "../../../server/fizot/proxy/meter.ts";
import type { TierPrice } from "../../../server/fizot/proxy/pricing.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL?.trim();
const TEST_SECRET = "fizot-test-hmac-p43-not-production-only-0123456789";

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

it.runIf(Boolean(databaseUrl))("Postgres ledger is append-only", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  try {
    await credit.ensureAccount(workspaceId, 10);
    await credit.grant({ workspaceId, amountMicroGbp: 10, requestId: `g-${workspaceId}`, kind: "grant" });
    const result = await credit.tryMutateLedger();
    expect(result).toBe("rejected");
    expect(await credit.settledMicroGbp(workspaceId)).toBe(0);
    expect((await credit.summary(workspaceId)).balanceMicroGbp).toBe(10);
    console.log("append_only", { result, balanceMicroGbp: 10 });
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: 50 parallel requests cannot overspend a balance of 10", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  try {
    await credit.ensureAccount(workspaceId, 10);
    await credit.grant({ workspaceId, amountMicroGbp: 10, requestId: `g-${workspaceId}`, kind: "grant" });
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => meterCompletion({ idempotencySecret: TEST_SECRET,
      credit,
      workspaceId,
      requestId: `r-${workspaceId}-${index}`,
      tier: "fast",
      rawBody: Buffer.from("{}"),
      parsed: { max_tokens: 1 },
      prices: UNIT,
      forward: async () => ({
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({
          model: "internal-fast",
          usage: { prompt_tokens: 0, completion_tokens: 1 },
        })),
      }),
    })));
    const ok = results.filter((row) => row.status === 200).length;
    const denied = results.filter((row) => row.status === 402).length;
    const settled = await credit.settledMicroGbp(workspaceId);
    const balance = (await credit.summary(workspaceId)).balanceMicroGbp;
    expect(ok).toBe(10);
    expect(denied).toBe(40);
    expect(settled).toBe(10);
    expect(settled).toBeLessThanOrEqual(10 + 1);
    expect(balance).toBe(0);
    console.log("postgres_concurrency", {
      balanceBefore: 10,
      ok,
      denied,
      settledMicroGbp: settled,
      balanceMicroGbp: balance,
    });
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres rejects cross-tenant replay and never persists new model-response bodies", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const owner = `ws-${randomUUID()}`;
  const foreign = `ws-${randomUUID()}`;
  const requestId = `req-${randomUUID()}`;
  const fingerprint = "a".repeat(64);
  try {
    for (const workspaceId of [owner, foreign]) {
      await credit.ensureAccount(workspaceId, 10);
      await credit.grant({ workspaceId, amountMicroGbp: 10, requestId: `grant-${workspaceId}` });
    }
    const reserved = await credit.tryReserve({ workspaceId: owner, requestId, amountMicroGbp: 1, requestFingerprint: fingerprint });
    expect(reserved.ok).toBe(true);
    await expect(credit.settle({
      workspaceId: foreign, requestId, amountMicroGbp: 1,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 1, httpStatus: 200,
    })).rejects.toThrow("reservation ownership mismatch");
    await credit.settle({
      workspaceId: owner, requestId, amountMicroGbp: 1,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 1, httpStatus: 200,
    });
    const collision = await credit.tryReserve({ workspaceId: foreign, requestId, amountMicroGbp: 1, requestFingerprint: fingerprint });
    expect(collision).toEqual({ ok: false, reason: "conflict" });
    const changed = await credit.tryReserve({ workspaceId: owner, requestId, amountMicroGbp: 1, requestFingerprint: "b".repeat(64) });
    expect(changed).toEqual({ ok: false, reason: "conflict" });
    const replay = await credit.tryReserve({ workspaceId: owner, requestId, amountMicroGbp: 1, requestFingerprint: fingerprint });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("replay");
    expect((await credit.summary(foreign)).balanceMicroGbp).toBe(10);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const result = await pool.query("SELECT to_jsonb(r) AS value FROM fizot_credit_reservations r WHERE request_id = $1", [requestId]);
      const row = result.rows[0]?.value as Record<string, unknown> | undefined;
      expect(row?.request_fingerprint).toBe(fingerprint);
      expect(row?.response_body ?? null).toBeNull();
      expect(row?.content_type ?? null).toBeNull();
    } finally {
      await pool.end();
    }
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres concurrent cross-tenant duplicate IDs fail closed", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const first = `ws-${randomUUID()}`;
  const second = `ws-${randomUUID()}`;
  const requestId = `shared-${randomUUID()}`;
  try {
    for (const workspaceId of [first, second]) {
      await credit.ensureAccount(workspaceId, 1);
      await credit.grant({ workspaceId, amountMicroGbp: 1, requestId: `grant-${workspaceId}` });
    }
    const results = await Promise.all([first, second].map((workspaceId, i) => credit.tryReserve({
      workspaceId, requestId, amountMicroGbp: 1, requestFingerprint: (i ? "b" : "a").repeat(64),
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "conflict" }]);
  } finally {
    await credit.close();
  }
});
