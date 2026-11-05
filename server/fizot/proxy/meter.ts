import { createHash } from "node:crypto";
import type { CreditStore } from "./credit-store.ts";
import { periodKey } from "./credit-store.ts";
import { isTierId, quoteMicroGbp, tierPrice, type TierId, type TierPrice } from "./pricing.ts";

export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export type UsageTokens = { inputTokens: number; outputTokens: number };

export function estimateInputTokens(body: Buffer): number {
  return Math.ceil(body.byteLength / 4);
}

export function readMaxOutputTokens(parsed: { max_tokens?: unknown; max_completion_tokens?: unknown }): number {
  const raw = parsed.max_tokens ?? parsed.max_completion_tokens;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

export function parseUsage(body: string, stream: boolean): UsageTokens | null {
  if (!stream) {
    try {
      const json = JSON.parse(body) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const prompt = json.usage?.prompt_tokens;
      const completion = json.usage?.completion_tokens;
      if (typeof prompt === "number" && typeof completion === "number") {
        return { inputTokens: prompt, outputTokens: completion };
      }
    } catch {
      return null;
    }
    return null;
  }
  let found: UsageTokens | null = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (typeof json.usage?.prompt_tokens === "number" && typeof json.usage?.completion_tokens === "number") {
        found = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      }
    } catch {
      /* ignore non-json frames */
    }
  }
  return found;
}

export function createRateLimiter(limitPerMinute: number) {
  const hits = new Map<string, number[]>();
  return {
    allow(workspaceId: string, now = Date.now()): boolean {
      const fresh = (hits.get(workspaceId) ?? []).filter((at) => now - at < 60_000);
      if (fresh.length >= limitPerMinute) {
        hits.set(workspaceId, fresh);
        return false;
      }
      fresh.push(now);
      hits.set(workspaceId, fresh);
      return true;
    },
  };
}

export type SoftAlertEvent = {
  kind: "credit_soft_80";
  workspaceIdHash: string;
  period: string;
  usageMicroGbp: number;
  includedMicroGbp: number;
};

export function workspaceIdHash(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

export type MeterOutcome = {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  forwarded: boolean;
};

function jsonOutcome(status: number, body: unknown, headers: Record<string, string> = {}): MeterOutcome {
  return {
    status,
    body: JSON.stringify(body),
    contentType: "application/json",
    headers,
    forwarded: false,
  };
}

export async function meterCompletion(input: {
  credit: CreditStore;
  workspaceId: string;
  requestId: string;
  tier: string;
  rawBody: Buffer;
  parsed: { max_tokens?: unknown; max_completion_tokens?: unknown; stream?: boolean };
  prices?: readonly TierPrice[];
  now?: number;
  rateLimiter?: ReturnType<typeof createRateLimiter>;
  onSoftAlert?: (event: SoftAlertEvent) => Promise<void>;
  forward: (providerBody: Buffer, providerModel: string) => Promise<{
    status: number;
    contentType: string;
    body: Buffer;
  }>;
  /** Strip provider keys from bodies. Must not blank a normal completion. */
  redactBody?: (body: string) => string;
}): Promise<MeterOutcome> {
  const now = input.now ?? Date.now();
  const headers = { "x-request-id": input.requestId };
  if (process.env.FIZOT_PROXY_DISABLED === "1" || await input.credit.disabled()) {
    return jsonOutcome(503, { error: "proxy_disabled" }, headers);
  }
  if (input.rateLimiter && !input.rateLimiter.allow(input.workspaceId, now)) {
    return jsonOutcome(429, { error: "rate_limited" }, headers);
  }
  if (!isTierId(input.tier)) {
    return jsonOutcome(400, { error: "unknown_tier" }, headers);
  }
  const tier: TierId = input.tier;
  const price = tierPrice(tier, input.prices);
  const maxOutput = readMaxOutputTokens(input.parsed);
  const inputTokens = estimateInputTokens(input.rawBody);
  const reserve = quoteMicroGbp({
    tier,
    inputTokens,
    outputTokens: maxOutput,
    table: input.prices,
  }).totalMicroGbp;

  const reserved = await input.credit.tryReserve({
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    amountMicroGbp: reserve,
  });
  if (!reserved.ok && reserved.reason === "replay") {
    return {
      status: reserved.reservation.httpStatus ?? 200,
      body: reserved.reservation.responseBody ?? "",
      contentType: reserved.reservation.contentType ?? "application/json",
      headers,
      forwarded: false,
    };
  }
  if (!reserved.ok && reserved.reason === "in_flight") {
    return jsonOutcome(409, { error: "in_flight", request_id: input.requestId }, headers);
  }
  if (!reserved.ok) {
    return jsonOutcome(402, { error: "insufficient_credit" }, headers);
  }

  let upstream: { status: number; contentType: string; body: Buffer };
  try {
    const rewritten = rewriteModel(input.rawBody, price.model);
    upstream = await input.forward(rewritten, price.model);
  } catch {
    await input.credit.release(input.requestId);
    return jsonOutcome(502, { error: "provider_unavailable" }, headers);
  }
  const hide = input.redactBody ?? ((body: string) => body);
  if (upstream.status >= 500) {
    await input.credit.release(input.requestId);
    return {
      status: upstream.status,
      body: hide(upstream.body.toString("utf8")),
      contentType: upstream.contentType,
      headers,
      forwarded: true,
    };
  }

  const text = upstream.body.toString("utf8");
  const usage = parseUsage(text, Boolean(input.parsed.stream));
  const charge = usage
    ? quoteMicroGbp({
      tier,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      table: input.prices,
    }).totalMicroGbp
    : reserve;
  const customerBody = hide(text.split(price.model).join(tier).split(price.provider).join(tier));
  await input.credit.settle({
    requestId: input.requestId,
    amountMicroGbp: charge,
    provider: price.provider,
    model: price.model,
    tier,
    inputTokens: usage?.inputTokens ?? inputTokens,
    outputTokens: usage?.outputTokens ?? maxOutput,
    httpStatus: upstream.status,
    responseBody: customerBody,
    contentType: upstream.contentType,
    meta: { charged: usage ? "usage" : "reserved" },
  });
  await maybeAlert(input.credit, input.workspaceId, now, input.onSoftAlert);
  return {
    status: upstream.status,
    body: customerBody,
    contentType: upstream.contentType,
    headers,
    forwarded: true,
  };
}

async function maybeAlert(
  credit: CreditStore,
  workspaceId: string,
  now: number,
  onSoftAlert: ((event: SoftAlertEvent) => Promise<void>) | undefined,
): Promise<void> {
  const summary = await credit.summary(workspaceId, now);
  if (summary.includedMicroGbp <= 0) return;
  const crossed = summary.periodUsageMicroGbp * 5 >= summary.includedMicroGbp * 4;
  if (!crossed) return;
  const first = await credit.markAlerted(workspaceId, summary.period);
  if (!first || !onSoftAlert) return;
  await onSoftAlert({
    kind: "credit_soft_80",
    workspaceIdHash: workspaceIdHash(workspaceId),
    period: summary.period || periodKey(now),
    usageMicroGbp: summary.periodUsageMicroGbp,
    includedMicroGbp: summary.includedMicroGbp,
  });
}

function rewriteModel(raw: Buffer, model: string): Buffer {
  try {
    const json = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    json.model = model;
    return Buffer.from(JSON.stringify(json));
  } catch {
    return raw;
  }
}
