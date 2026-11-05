import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPostgresCreditStore } from "../../../server/fizot/proxy/credit-store.ts";
import { meterCompletion } from "../../../server/fizot/proxy/meter.ts";
import type { TierPrice } from "../../../server/fizot/proxy/pricing.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL?.trim();

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
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => meterCompletion({
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
