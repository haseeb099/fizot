/**
 * Credit hard-cap, lot residual, and 12-month expiry helpers.
 * Money is always integer micro-GBP. Calendar months are UTC.
 */

export const MAX_OUTPUT_TOKENS_CAP = 128_000;
/** Reserved/uncertain rows older than this may be recovered fail-closed. */
export const RESERVATION_RECOVERY_GRACE_MS = 15 * 60_000;

export type CreditLotKind = "grant" | "refund" | "adjust";

export type CreditLotSource = {
  id: string;
  kind: CreditLotKind | "usage" | "expire";
  amountMicroGbp: number;
  createdAtMs: number;
  /** Null = legacy grandfathered grant; not auto-expired until an operator migrates it. */
  expiresAtMs: number | null;
  requestId: string | null;
};

export function addUtcCalendarMonths(fromMs: number, months: number): number {
  if (!Number.isInteger(fromMs) || !Number.isInteger(months) || months < 0) {
    throw new Error("invalid_calendar_month_input");
  }
  const date = new Date(fromMs);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

export function defaultGrantExpiresAtMs(grantedAtMs: number): number {
  return addUtcCalendarMonths(grantedAtMs, 12);
}

export function parseMaxOutputTokens(raw: unknown):
  | { ok: true; tokens: number }
  | { ok: false; reason: "invalid_max_tokens" | "max_tokens_too_large" } {
  if (raw === undefined || raw === null) return { ok: true, tokens: 1024 };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return { ok: false, reason: "invalid_max_tokens" };
  }
  if (raw > MAX_OUTPUT_TOKENS_CAP) return { ok: false, reason: "max_tokens_too_large" };
  return { ok: true, tokens: raw };
}

export function sanitizeUsageTokens(input: {
  inputTokens: unknown;
  outputTokens: unknown;
}): { inputTokens: number; outputTokens: number } | null {
  const inputTokens = input.inputTokens;
  const outputTokens = input.outputTokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) return null;
  if (inputTokens < 0 || outputTokens < 0) return null;
  if (inputTokens > 100_000_000 || outputTokens > 100_000_000) return null;
  return { inputTokens, outputTokens };
}

function isPositiveLot(row: CreditLotSource): boolean {
  return row.kind === "grant" || row.kind === "refund" || (row.kind === "adjust" && row.amountMicroGbp > 0);
}

/** Same-ms ties: credits before debits so a settle cannot sort ahead of its grant. */
function lotOrder(a: CreditLotSource, b: CreditLotSource): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  const aCredit = isPositiveLot(a) ? 0 : 1;
  const bCredit = isPositiveLot(b) ? 0 : 1;
  if (aCredit !== bCredit) return aCredit - bCredit;
  return a.id.localeCompare(b.id);
}

/**
 * Consumption order: oldest positive grant/refund/adjust(+) first (FIFO).
 * Only `usage` and negative `adjust` consume lots. Compensating `expire` rows
 * are append-only audit; spendability itself uses expiresAtMs so expiry is not
 * applied twice. Legacy null expiresAt never auto-expires.
 */
export function spendableMicroGbp(sources: readonly CreditLotSource[], nowMs: number): number {
  const lots: Array<{ remaining: number; expiresAtMs: number | null }> = [];
  const ordered = [...sources].sort(lotOrder);
  for (const row of ordered) {
    if (isPositiveLot(row)) {
      lots.push({ remaining: row.amountMicroGbp, expiresAtMs: row.expiresAtMs });
      continue;
    }
    if (row.kind === "expire") continue;
    if (row.kind !== "usage" && !(row.kind === "adjust" && row.amountMicroGbp < 0)) continue;
    let need = Math.abs(row.amountMicroGbp);
    for (const lot of lots) {
      if (need <= 0) break;
      if (lot.remaining <= 0) continue;
      const take = Math.min(lot.remaining, need);
      lot.remaining -= take;
      need -= take;
    }
  }
  let spendable = 0;
  for (const lot of lots) {
    if (lot.remaining <= 0) continue;
    if (lot.expiresAtMs != null && lot.expiresAtMs <= nowMs) continue;
    spendable += lot.remaining;
  }
  return spendable;
}

export type ExpirableGrant = {
  id: string;
  requestId: string;
  amountMicroGbp: number;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Residual still on an expired grant lot after FIFO usage/negative adjusts. */
export function expiredGrantResiduals(
  sources: readonly CreditLotSource[],
  nowMs: number,
): Array<{ grantId: string; grantRequestId: string; residualMicroGbp: number }> {
  const alreadyExpired = new Set(
    sources
      .filter((row) => row.kind === "expire" && row.requestId?.startsWith("expire:"))
      .map((row) => row.requestId!.slice("expire:".length)),
  );
  const lots: Array<{
    grantId: string;
    grantRequestId: string;
    remaining: number;
    expiresAtMs: number | null;
  }> = [];
  const ordered = [...sources].sort(lotOrder);
  for (const row of ordered) {
    if (isPositiveLot(row)) {
      lots.push({
        grantId: row.id,
        grantRequestId: row.requestId ?? row.id,
        remaining: row.amountMicroGbp,
        expiresAtMs: row.expiresAtMs,
      });
      continue;
    }
    if (row.kind === "expire") continue;
    if (row.kind !== "usage" && !(row.kind === "adjust" && row.amountMicroGbp < 0)) continue;
    let need = Math.abs(row.amountMicroGbp);
    for (const lot of lots) {
      if (need <= 0) break;
      if (lot.remaining <= 0) continue;
      const take = Math.min(lot.remaining, need);
      lot.remaining -= take;
      need -= take;
    }
  }
  const out: Array<{ grantId: string; grantRequestId: string; residualMicroGbp: number }> = [];
  for (const lot of lots) {
    if (lot.remaining <= 0) continue;
    if (lot.expiresAtMs == null || lot.expiresAtMs > nowMs) continue;
    if (alreadyExpired.has(lot.grantId)) continue;
    out.push({
      grantId: lot.grantId,
      grantRequestId: lot.grantRequestId,
      residualMicroGbp: lot.remaining,
    });
  }
  return out;
}

export function clampSettleToReservation(actualMicroGbp: number, reservedMicroGbp: number): {
  settleMicroGbp: number;
  exceeded: boolean;
} {
  if (!Number.isInteger(actualMicroGbp) || !Number.isInteger(reservedMicroGbp)) {
    throw new Error("settle amounts must be integers");
  }
  if (reservedMicroGbp < 0 || actualMicroGbp < 0) throw new Error("settle amounts must be non-negative");
  if (actualMicroGbp <= reservedMicroGbp) {
    return { settleMicroGbp: actualMicroGbp, exceeded: false };
  }
  return { settleMicroGbp: reservedMicroGbp, exceeded: true };
}
