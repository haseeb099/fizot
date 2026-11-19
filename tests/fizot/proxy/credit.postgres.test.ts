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

it.runIf(Boolean(databaseUrl))("Postgres: two racing last-credit requests and usage over-reservation clamp", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const fingerprint = "c".repeat(64);
  try {
    await credit.ensureAccount(workspaceId, 1);
    await credit.grant({ workspaceId, amountMicroGbp: 1, requestId: `g-${workspaceId}` });
    const results = await Promise.all(["a", "b"].map((suffix) => credit.tryReserve({
      workspaceId,
      requestId: `race-${workspaceId}-${suffix}`,
      amountMicroGbp: 1,
      requestFingerprint: fingerprint,
    })));
    expect(results.filter((row) => row.ok)).toHaveLength(1);
    expect(results.filter((row) => !row.ok && row.reason === "insufficient")).toHaveLength(1);

    const winner = results.find((row) => row.ok);
    if (!winner || !winner.ok) throw new Error("expected winner");
    const settled = await credit.settle({
      workspaceId,
      requestId: winner.reservation.requestId,
      amountMicroGbp: 50,
      provider: "xai",
      model: "internal-fast",
      tier: "fast",
      inputTokens: 0,
      outputTokens: 50,
      httpStatus: 200,
      meta: { response: "must-not-store", prompt: "must-not-store" },
    });
    expect(settled.amountMicroGbp).toBe(-1);
    expect(settled.meta.cappedToReservation).toBe(true);
    expect(settled.meta.response).toBeUndefined();
    expect(settled.meta.prompt).toBeUndefined();
    expect((await credit.summary(workspaceId)).balanceMicroGbp).toBe(0);
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: uncertain recovery quarantines without fabricating usage", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const requestId = `unc-${randomUUID()}`;
  const now = Date.UTC(2025, 5, 1, 12, 0, 0);
  try {
    await credit.ensureAccount(workspaceId, 10);
    await credit.grant({ workspaceId, amountMicroGbp: 10, requestId: `g-${workspaceId}`, nowMs: now });
    const reserved = await credit.tryReserve({
      workspaceId, requestId, amountMicroGbp: 4, requestFingerprint: "d".repeat(64), nowMs: now,
    });
    expect(reserved.ok).toBe(true);
    await credit.markDispatched(workspaceId, requestId, now);
    await credit.markUncertain(workspaceId, requestId, now);
    expect((await credit.summary(workspaceId, now)).reservedMicroGbp).toBe(4);

    const tooSoon = await credit.recoverStaleReservations({
      workspaceId, nowMs: now + 60_000, graceMs: 15 * 60_000,
    });
    expect(tooSoon.released + tooSoon.quarantined).toBe(0);

    const [a, b] = await Promise.all([
      credit.recoverStaleReservations({ workspaceId, nowMs: now + 16 * 60_000, graceMs: 15 * 60_000 }),
      credit.recoverStaleReservations({ workspaceId, nowMs: now + 16 * 60_000, graceMs: 15 * 60_000 }),
    ]);
    expect(a.quarantined + b.quarantined).toBe(1);
    expect(a.released + b.released).toBe(0);
    expect(await credit.settledMicroGbp(workspaceId)).toBe(0);
    expect(await credit.usageCount(workspaceId)).toBe(0);
    expect((await credit.summary(workspaceId, now + 16 * 60_000)).reservedMicroGbp).toBe(4);

    await credit.settle({
      workspaceId, requestId, amountMicroGbp: 2,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 2, httpStatus: 200, nowMs: now + 20 * 60_000,
    });
    expect(await credit.settledMicroGbp(workspaceId)).toBe(2);
    expect((await credit.summary(workspaceId, now + 20 * 60_000)).reservedMicroGbp).toBe(0);
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: undelivered reserved recovery releases without usage", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const requestId = `crash-${randomUUID()}`;
  const now = Date.UTC(2025, 4, 1);
  try {
    await credit.ensureAccount(workspaceId, 8);
    await credit.grant({ workspaceId, amountMicroGbp: 8, requestId: `g-${workspaceId}`, nowMs: now });
    await credit.tryReserve({
      workspaceId, requestId, amountMicroGbp: 3, requestFingerprint: "9".repeat(64), nowMs: now,
    });
    const recovered = await credit.recoverStaleReservations({
      workspaceId, nowMs: now + 16 * 60_000, graceMs: 15 * 60_000,
    });
    expect(recovered.released).toBe(1);
    expect(recovered.quarantined).toBe(0);
    expect(await credit.usageCount(workspaceId)).toBe(0);
    expect((await credit.summary(workspaceId, now + 16 * 60_000)).balanceMicroGbp).toBe(8);
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: reserve before expiry settle after keeps funding attribution", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const requestId = `cross-${randomUUID()}`;
  try {
    await credit.ensureAccount(workspaceId, 10);
    await credit.grant({
      workspaceId, amountMicroGbp: 10, requestId: `g-${workspaceId}`, nowMs: Date.UTC(2024, 0, 1),
    });
    const reserved = await credit.tryReserve({
      workspaceId, requestId, amountMicroGbp: 10, requestFingerprint: "c".repeat(64),
      nowMs: Date.UTC(2024, 11, 31, 23, 59),
    });
    expect(reserved.ok).toBe(true);
    expect(await credit.expireDue(workspaceId, Date.UTC(2025, 0, 1))).toBe(0);
    await credit.settle({
      workspaceId, requestId, amountMicroGbp: 10,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 10, httpStatus: 200, nowMs: Date.UTC(2025, 0, 1, 0, 1),
    });
    expect(await credit.settledMicroGbp(workspaceId)).toBe(10);
    expect((await credit.summary(workspaceId, Date.UTC(2025, 0, 2))).balanceMicroGbp).toBe(0);
    expect(await credit.expireDue(workspaceId, Date.UTC(2025, 0, 2))).toBe(0);
  } finally {
    await credit.close();
  }

  const reopened = await createPostgresCreditStore(databaseUrl!);
  try {
    expect((await reopened.summary(workspaceId, Date.UTC(2025, 0, 2))).balanceMicroGbp).toBe(0);
    expect(await reopened.settledMicroGbp(workspaceId)).toBe(10);
  } finally {
    await reopened.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: concurrent recovery release vs dispatch is atomic", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const requestId = `race-${randomUUID()}`;
  const now = Date.UTC(2025, 7, 1);
  try {
    await credit.ensureAccount(workspaceId, 5);
    await credit.grant({ workspaceId, amountMicroGbp: 5, requestId: `g-${workspaceId}`, nowMs: now });
    await credit.tryReserve({
      workspaceId, requestId, amountMicroGbp: 5, requestFingerprint: "d".repeat(64), nowMs: now,
    });
    const [recovery, dispatch] = await Promise.all([
      credit.recoverStaleReservations({
        workspaceId, nowMs: now + 16 * 60_000, graceMs: 15 * 60_000,
      }),
      credit.markDispatched(workspaceId, requestId, now + 16 * 60_000),
    ]);
    const released = recovery.released === 1;
    const dispatched = dispatch.ok === true;
    // Exactly one winner: either recovery released or dispatch succeeded.
    expect(Number(released) + Number(dispatched)).toBe(1);
    if (dispatched) {
      expect(recovery.released).toBe(0);
    } else {
      expect(dispatch).toEqual({ ok: false, reason: "not_reserved" });
    }
    expect(await credit.usageCount(workspaceId)).toBe(0);
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: later usage cannot consume expired grant residual", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  try {
    await credit.ensureAccount(workspaceId, 20);
    await credit.grant({
      workspaceId, amountMicroGbp: 10, requestId: `old-${workspaceId}`, nowMs: Date.UTC(2024, 0, 1),
    });
    await credit.grant({
      workspaceId, amountMicroGbp: 10, requestId: `new-${workspaceId}`, nowMs: Date.UTC(2025, 0, 1),
    });
    expect((await credit.summary(workspaceId, Date.UTC(2024, 11, 31))).balanceMicroGbp).toBe(20);

    // Expire audit before later usage (tryReserve also expireDue's; must stay idempotent).
    expect(await credit.expireDue(workspaceId, Date.UTC(2025, 0, 2))).toBe(1);
    expect(await credit.expireDue(workspaceId, Date.UTC(2025, 0, 2))).toBe(0);
    expect((await credit.summary(workspaceId, Date.UTC(2025, 0, 2))).balanceMicroGbp).toBe(10);

    const requestId = `later-${workspaceId}`;
    await credit.tryReserve({
      workspaceId, requestId, amountMicroGbp: 7, requestFingerprint: "a".repeat(64),
      nowMs: Date.UTC(2025, 0, 2),
    });
    await credit.settle({
      workspaceId, requestId, amountMicroGbp: 7,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 7, httpStatus: 200, nowMs: Date.UTC(2025, 0, 2),
    });
    expect(await credit.settledMicroGbp(workspaceId)).toBe(7);
    expect((await credit.summary(workspaceId, Date.UTC(2025, 0, 3))).balanceMicroGbp).toBe(3);
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: 12-month expiry is append-only and idempotent with legacy grants", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const grantedAt = Date.UTC(2024, 1, 29, 8, 0, 0);
  try {
    await credit.ensureAccount(workspaceId, 30);
    const fresh = await credit.grant({
      workspaceId, amountMicroGbp: 20, requestId: `fresh-${workspaceId}`, kind: "grant", nowMs: grantedAt,
    });
    await credit.grant({
      workspaceId, amountMicroGbp: 10, requestId: `legacy-${workspaceId}`, kind: "grant",
      nowMs: grantedAt, expireInTwelveMonths: false,
    });
    expect(fresh.expiresAt).toBe(new Date(Date.UTC(2025, 1, 28, 8, 0, 0)).toISOString());

    const before = await credit.summary(workspaceId, Date.UTC(2025, 1, 28, 7, 59, 59));
    expect(before.balanceMicroGbp).toBe(30);
    const [e1, e2] = await Promise.all([
      credit.expireDue(workspaceId, Date.UTC(2025, 1, 28, 8, 0, 0)),
      credit.expireDue(workspaceId, Date.UTC(2025, 1, 28, 8, 0, 0)),
    ]);
    expect(e1 + e2).toBe(1);
    const after = await credit.summary(workspaceId, Date.UTC(2025, 1, 28, 8, 0, 0));
    expect(after.balanceMicroGbp).toBe(10);

    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const grants = await pool.query(
        `SELECT kind, amount_micro_gbp, request_id, meta FROM fizot_credit_ledger WHERE workspace_id = $1 ORDER BY created_at, id`,
        [workspaceId],
      );
      const expireRow = grants.rows.find((row) => row.kind === "expire");
      expect(expireRow?.amount_micro_gbp).toBe("-20");
      expect(String(expireRow?.request_id)).toMatch(/^expire:/);
      expect(JSON.stringify(expireRow?.meta)).not.toMatch(/prompt|completion|messages/);
      const original = grants.rows.find((row) => row.request_id === `fresh-${workspaceId}`);
      expect(original?.amount_micro_gbp).toBe("20");
    } finally {
      await pool.end();
    }

    const denied = await credit.tryReserve({
      workspaceId,
      requestId: `after-${workspaceId}`,
      amountMicroGbp: 11,
      requestFingerprint: "e".repeat(64),
      nowMs: Date.UTC(2025, 1, 28, 9, 0, 0),
    });
    expect(denied).toEqual({ ok: false, reason: "insufficient" });
  } finally {
    await credit.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: overlapping reserves bind distinct grants; reverse settle + expiry", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const at = Date.UTC(2024, 11, 15);
  const expireA = Date.UTC(2025, 0, 1);
  try {
    await credit.ensureAccount(workspaceId, 20);
    const grantA = await credit.grant({
      workspaceId, amountMicroGbp: 10, requestId: `gA-${workspaceId}`, nowMs: Date.UTC(2024, 0, 1),
    });
    const grantB = await credit.grant({
      workspaceId, amountMicroGbp: 10, requestId: `gB-${workspaceId}`, nowMs: Date.UTC(2024, 0, 2),
    });
    const r1 = await credit.tryReserve({
      workspaceId, requestId: `R1-${workspaceId}`, amountMicroGbp: 10, requestFingerprint: "a".repeat(64), nowMs: at,
    });
    const r2 = await credit.tryReserve({
      workspaceId, requestId: `R2-${workspaceId}`, amountMicroGbp: 10, requestFingerprint: "b".repeat(64), nowMs: at + 1,
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.reservation.funding).toEqual([{ grantId: grantA.id, amountMicroGbp: 10 }]);
    expect(r2.reservation.funding).toEqual([{ grantId: grantB.id, amountMicroGbp: 10 }]);

    // Settle newer reservation first, then expire while older hold remains.
    await credit.settle({
      workspaceId, requestId: `R2-${workspaceId}`, amountMicroGbp: 10,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 10, httpStatus: 200, nowMs: at + 2,
    });
    expect(await credit.expireDue(workspaceId, expireA)).toBe(0);
    expect((await credit.summary(workspaceId, expireA)).reservedMicroGbp).toBe(10);
    expect((await credit.summary(workspaceId, expireA)).balanceMicroGbp).toBe(10);
    await credit.settle({
      workspaceId, requestId: `R1-${workspaceId}`, amountMicroGbp: 10,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 10, httpStatus: 200, nowMs: expireA + 1,
    });
    expect(await credit.settledMicroGbp(workspaceId)).toBe(20);
    expect(await credit.expireDue(workspaceId, expireA + 1)).toBe(0);
  } finally {
    await credit.close();
  }

  const reopened = await createPostgresCreditStore(databaseUrl!);
  try {
    expect((await reopened.summary(workspaceId, expireA + 2)).balanceMicroGbp).toBe(0);
    expect(await reopened.settledMicroGbp(workspaceId)).toBe(20);
  } finally {
    await reopened.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: two connections cannot double-claim the same grant residual", async () => {
  const a = await createPostgresCreditStore(databaseUrl!);
  const b = await createPostgresCreditStore(databaseUrl!);
  const workspaceId = `ws-${randomUUID()}`;
  const at = Date.UTC(2024, 11, 15);
  try {
    await a.ensureAccount(workspaceId, 20);
    const grantA = await a.grant({
      workspaceId, amountMicroGbp: 10, requestId: `gA-${workspaceId}`, nowMs: Date.UTC(2024, 0, 1),
    });
    const grantB = await a.grant({
      workspaceId, amountMicroGbp: 10, requestId: `gB-${workspaceId}`, nowMs: Date.UTC(2024, 0, 2),
    });
    const [r1, r2] = await Promise.all([
      a.tryReserve({
        workspaceId, requestId: `c1-${workspaceId}`, amountMicroGbp: 10, requestFingerprint: "a".repeat(64), nowMs: at,
      }),
      b.tryReserve({
        workspaceId, requestId: `c2-${workspaceId}`, amountMicroGbp: 10, requestFingerprint: "b".repeat(64), nowMs: at,
      }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const ids = [
      r1.reservation.funding.map((slice) => slice.grantId).join(","),
      r2.reservation.funding.map((slice) => slice.grantId).join(","),
    ].sort();
    expect(ids).toEqual([grantA.id, grantB.id].sort());
    expect(r1.reservation.funding[0]?.grantId).not.toBe(r2.reservation.funding[0]?.grantId);
  } finally {
    await a.close();
    await b.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: foreign settle/release and restart-safe balance journey", async () => {
  const credit = await createPostgresCreditStore(databaseUrl!);
  const owner = `ws-${randomUUID()}`;
  const foreign = `ws-${randomUUID()}`;
  const requestId = `own-${randomUUID()}`;
  try {
    await credit.ensureAccount(owner, 12);
    await credit.grant({ workspaceId: owner, amountMicroGbp: 12, requestId: `g-${owner}` });
    await credit.ensureAccount(foreign, 12);
    await credit.grant({ workspaceId: foreign, amountMicroGbp: 12, requestId: `g-${foreign}` });

    const reserved = await credit.tryReserve({
      workspaceId: owner, requestId, amountMicroGbp: 5, requestFingerprint: "f".repeat(64),
    });
    expect(reserved.ok).toBe(true);
    await credit.release(foreign, requestId);
    expect((await credit.summary(owner)).reservedMicroGbp).toBe(5);
    await expect(credit.settle({
      workspaceId: foreign, requestId, amountMicroGbp: 5,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 5, httpStatus: 200,
    })).rejects.toThrow("reservation ownership mismatch");

    await credit.settle({
      workspaceId: owner, requestId, amountMicroGbp: 5,
      provider: "xai", model: "internal-fast", tier: "fast",
      inputTokens: 0, outputTokens: 5, httpStatus: 200,
    });
  } finally {
    await credit.close();
  }

  const reopened = await createPostgresCreditStore(databaseUrl!);
  try {
    const summary = await reopened.summary(owner);
    expect(summary.balanceMicroGbp).toBe(7);
    expect(summary.reservedMicroGbp).toBe(0);
    expect(await reopened.settledMicroGbp(owner)).toBe(5);
    expect((await reopened.summary(foreign)).balanceMicroGbp).toBe(12);
  } finally {
    await reopened.close();
  }
});
