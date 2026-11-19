/**
 * Credit hard-cap, lot residual, and 12-month expiry helpers.
 * Money is always integer micro-GBP. Calendar months are UTC.
 */

export const MAX_OUTPUT_TOKENS_CAP = 128_000;
/** Grace before undelivered `reserved` may be released, or uncertain→quarantined. */
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
  /**
   * For usage: when the reservation authorized funding. Lot validity uses this
   * instant, while createdAtMs remains the ledger posting time.
   */
  fundingAuthorizedAtMs?: number | null;
};

/** Auditable FIFO slices bound to a reservation at authorize time. */
export type FundingSlice = {
  grantId: string;
  amountMicroGbp: number;
};

export type OpenHold = {
  authorizedAtMs: number;
  funding: readonly FundingSlice[];
};

export type AllocatedLot = {
  grantId: string;
  grantRequestId: string;
  remaining: number;
  expiresAtMs: number | null;
  createdAtMs: number;
};

export type UncoveredDebit = {
  id: string;
  requestId: string | null;
  kind: "usage" | "adjust";
  amountMicroGbp: number;
  createdAtMs: number;
  uncoveredMicroGbp: number;
};

export type AllocationResult = {
  lots: AllocatedLot[];
  uncoveredDebits: UncoveredDebit[];
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

/** Reject unsafe / non-integer / wrong-sign ledger credit amounts. */
export function assertLedgerAmount(
  kind: "grant" | "refund" | "adjust" | "usage" | "expire",
  amountMicroGbp: number,
): void {
  if (typeof amountMicroGbp !== "number" || !Number.isSafeInteger(amountMicroGbp)) {
    throw new Error("amountMicroGbp must be a safe integer");
  }
  if (kind === "grant" || kind === "refund") {
    if (amountMicroGbp <= 0) throw new Error(`${kind} amount must be positive`);
    return;
  }
  if (kind === "adjust") {
    if (amountMicroGbp === 0) throw new Error("adjust amount must be non-zero");
    return;
  }
  if (kind === "usage" || kind === "expire") {
    if (amountMicroGbp >= 0) throw new Error(`${kind} amount must be negative`);
  }
}

function isPositiveLot(row: CreditLotSource): boolean {
  if (!Number.isSafeInteger(row.amountMicroGbp) || row.amountMicroGbp <= 0) return false;
  return row.kind === "grant" || row.kind === "refund" || row.kind === "adjust";
}

function isDebit(row: CreditLotSource): boolean {
  if (row.kind === "usage") return true;
  if (row.kind === "adjust" && row.amountMicroGbp < 0) return true;
  return false;
}

/** Lot is spendable at debitMs when expiresAt is null or strictly after debitMs. */
export function lotValidAt(expiresAtMs: number | null, atMs: number): boolean {
  if (expiresAtMs == null) return true;
  return expiresAtMs > atMs;
}

function debitEffectiveAt(row: CreditLotSource): number {
  if (row.kind === "usage" && row.fundingAuthorizedAtMs != null) {
    return row.fundingAuthorizedAtMs;
  }
  return row.createdAtMs;
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
 * Chronological allocation: each usage/negative adjust consumes FIFO among lots
 * still valid at the debit's effective funding time. Usage may carry
 * fundingAuthorizedAtMs (reservation authorize time) while createdAtMs is the
 * ledger posting time. Expire audit rows are ignored for consumption.
 */
export function allocateCreditLots(sources: readonly CreditLotSource[]): AllocationResult {
  const lots: AllocatedLot[] = [];
  const uncoveredDebits: UncoveredDebit[] = [];
  const ordered = [...sources].sort(lotOrder);
  for (const row of ordered) {
    if (isPositiveLot(row)) {
      lots.push({
        grantId: row.id,
        grantRequestId: row.requestId ?? row.id,
        remaining: row.amountMicroGbp,
        expiresAtMs: row.expiresAtMs,
        createdAtMs: row.createdAtMs,
      });
      continue;
    }
    if (row.kind === "expire") continue;
    if (!isDebit(row)) continue;
    let need = Math.abs(row.amountMicroGbp);
    const at = debitEffectiveAt(row);
    for (const lot of lots) {
      if (need <= 0) break;
      if (lot.remaining <= 0) continue;
      if (!lotValidAt(lot.expiresAtMs, at)) continue;
      const take = Math.min(lot.remaining, need);
      lot.remaining -= take;
      need -= take;
    }
    if (need > 0) {
      uncoveredDebits.push({
        id: row.id,
        requestId: row.requestId,
        kind: row.kind === "adjust" ? "adjust" : "usage",
        amountMicroGbp: row.amountMicroGbp,
        createdAtMs: row.createdAtMs,
        uncoveredMicroGbp: need,
      });
    }
  }
  return { lots, uncoveredDebits };
}

/** FIFO funding plan for a new reservation at authorize time. */
export function planFundingSlices(
  sources: readonly CreditLotSource[],
  amountMicroGbp: number,
  atMs: number,
): FundingSlice[] | null {
  if (!Number.isSafeInteger(amountMicroGbp) || amountMicroGbp < 0) {
    throw new Error("amountMicroGbp must be a non-negative safe integer");
  }
  if (amountMicroGbp === 0) return [];
  const { lots, uncoveredDebits } = allocateCreditLots(sources);
  if (uncoveredDebits.length > 0) throw new Error("uncovered_debit");
  let need = amountMicroGbp;
  const slices: FundingSlice[] = [];
  for (const lot of lots) {
    if (need <= 0) break;
    if (lot.remaining <= 0) continue;
    if (!lotValidAt(lot.expiresAtMs, atMs)) continue;
    const take = Math.min(lot.remaining, need);
    slices.push({ grantId: lot.grantId, amountMicroGbp: take });
    need -= take;
  }
  if (need > 0) return null;
  return slices;
}

function applyOpenHolds(lots: AllocatedLot[], openHolds: readonly OpenHold[]): void {
  for (const hold of openHolds) {
    for (const slice of hold.funding) {
      if (!Number.isSafeInteger(slice.amountMicroGbp) || slice.amountMicroGbp <= 0) {
        throw new Error("invalid_funding_slice");
      }
      const lot = lots.find((item) => item.grantId === slice.grantId);
      if (!lot) throw new Error("funding_slice_missing_lot");
      if (!lotValidAt(lot.expiresAtMs, hold.authorizedAtMs)) {
        throw new Error("funding_slice_expired_at_authorize");
      }
      if (lot.remaining < slice.amountMicroGbp) throw new Error("funding_slice_over_allocated");
      lot.remaining -= slice.amountMicroGbp;
    }
  }
}

/**
 * Spendable residual at nowMs after time-aware FIFO. Throws if any historical
 * debit was not fully covered by lots valid at its funding time (fail closed).
 */
export function spendableMicroGbp(sources: readonly CreditLotSource[], nowMs: number): number {
  const { lots, uncoveredDebits } = allocateCreditLots(sources);
  if (uncoveredDebits.length > 0) {
    throw new Error("uncovered_debit");
  }
  let spendable = 0;
  for (const lot of lots) {
    if (lot.remaining <= 0) continue;
    if (!lotValidAt(lot.expiresAtMs, nowMs)) continue;
    spendable += lot.remaining;
  }
  return spendable;
}

/** Residual still on an expired grant lot after usages and open reservation escrow. */
export function expiredGrantResiduals(
  sources: readonly CreditLotSource[],
  nowMs: number,
  openHolds: readonly OpenHold[] = [],
): Array<{ grantId: string; grantRequestId: string; residualMicroGbp: number }> {
  const alreadyExpired = new Set(
    sources
      .filter((row) => row.kind === "expire" && row.requestId?.startsWith("expire:"))
      .map((row) => row.requestId!.slice("expire:".length)),
  );
  const { lots, uncoveredDebits } = allocateCreditLots(sources);
  if (uncoveredDebits.length > 0) {
    throw new Error("uncovered_debit");
  }
  applyOpenHolds(lots, openHolds);
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

export function parseFundingSlices(raw: unknown): FundingSlice[] {
  if (!Array.isArray(raw)) throw new Error("invalid_funding");
  const out: FundingSlice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("invalid_funding");
    const grantId = (item as { grantId?: unknown }).grantId;
    const amountMicroGbp = (item as { amountMicroGbp?: unknown }).amountMicroGbp;
    if (typeof grantId !== "string" || grantId.length === 0) throw new Error("invalid_funding");
    if (!Number.isSafeInteger(amountMicroGbp) || (amountMicroGbp as number) <= 0) {
      throw new Error("invalid_funding");
    }
    out.push({ grantId, amountMicroGbp: amountMicroGbp as number });
  }
  return out;
}
