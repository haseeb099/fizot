import { expect, it } from "vitest";
import {
  addUtcCalendarMonths,
  assertLedgerAmount,
  clampSettleToReservation,
  defaultGrantExpiresAtMs,
  expiredGrantResiduals,
  parseMaxOutputTokens,
  sanitizeUsageTokens,
  spendableMicroGbp,
  type CreditLotSource,
} from "../../../server/fizot/proxy/credit-policy.ts";

it("adds UTC calendar months including leap-year day clamping", () => {
  const jan31 = Date.UTC(2024, 0, 31, 12, 0, 0);
  expect(new Date(addUtcCalendarMonths(jan31, 1)).toISOString()).toBe("2024-02-29T12:00:00.000Z");
  const feb29 = Date.UTC(2024, 1, 29, 15, 30, 0);
  expect(new Date(addUtcCalendarMonths(feb29, 12)).toISOString()).toBe("2025-02-28T15:30:00.000Z");
  const grant = Date.UTC(2025, 2, 15, 0, 0, 0);
  expect(defaultGrantExpiresAtMs(grant)).toBe(Date.UTC(2026, 2, 15, 0, 0, 0));
});

it("rejects invalid and oversized max_tokens fail-closed", () => {
  expect(parseMaxOutputTokens(undefined)).toEqual({ ok: true, tokens: 1024 });
  expect(parseMaxOutputTokens(0)).toEqual({ ok: false, reason: "invalid_max_tokens" });
  expect(parseMaxOutputTokens(-1)).toEqual({ ok: false, reason: "invalid_max_tokens" });
  expect(parseMaxOutputTokens(1.5)).toEqual({ ok: false, reason: "invalid_max_tokens" });
  expect(parseMaxOutputTokens("8")).toEqual({ ok: false, reason: "invalid_max_tokens" });
  expect(parseMaxOutputTokens(128_001)).toEqual({ ok: false, reason: "max_tokens_too_large" });
  expect(parseMaxOutputTokens(128_000)).toEqual({ ok: true, tokens: 128_000 });
});

it("sanitizes provider usage tokens and rejects malformed values", () => {
  expect(sanitizeUsageTokens({ inputTokens: 1, outputTokens: 2 })).toEqual({ inputTokens: 1, outputTokens: 2 });
  expect(sanitizeUsageTokens({ inputTokens: -1, outputTokens: 2 })).toBeNull();
  expect(sanitizeUsageTokens({ inputTokens: 1, outputTokens: 1.2 })).toBeNull();
  expect(sanitizeUsageTokens({ inputTokens: undefined, outputTokens: 2 })).toBeNull();
  expect(sanitizeUsageTokens({ inputTokens: 0, outputTokens: 100_000_001 })).toBeNull();
});

it("clamps settle to the reservation and flags overage", () => {
  expect(clampSettleToReservation(5, 10)).toEqual({ settleMicroGbp: 5, exceeded: false });
  expect(clampSettleToReservation(15, 10)).toEqual({ settleMicroGbp: 10, exceeded: true });
});

it("validates grant/refund/adjust amount signs and safe integers", () => {
  expect(() => assertLedgerAmount("grant", 1)).not.toThrow();
  expect(() => assertLedgerAmount("refund", 5)).not.toThrow();
  expect(() => assertLedgerAmount("adjust", 3)).not.toThrow();
  expect(() => assertLedgerAmount("adjust", -3)).not.toThrow();
  expect(() => assertLedgerAmount("grant", 0)).toThrow(/positive/);
  expect(() => assertLedgerAmount("grant", -1)).toThrow(/positive/);
  expect(() => assertLedgerAmount("refund", -2)).toThrow(/positive/);
  expect(() => assertLedgerAmount("adjust", 0)).toThrow(/non-zero/);
  expect(() => assertLedgerAmount("grant", Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
  expect(() => assertLedgerAmount("grant", 1.5)).toThrow(/safe integer/);
});

it("FIFO spendable ignores expired lots and grandfathered null expiresAt stays spendable", () => {
  const t0 = Date.UTC(2024, 0, 1);
  const expireAt = Date.UTC(2025, 0, 1);
  const sources: CreditLotSource[] = [
    { id: "g1", kind: "grant", amountMicroGbp: 10, createdAtMs: t0, expiresAtMs: expireAt, requestId: "g1" },
    { id: "g2", kind: "grant", amountMicroGbp: 7, createdAtMs: t0 + 1, expiresAtMs: null, requestId: "g2" },
    { id: "u1", kind: "usage", amountMicroGbp: -3, createdAtMs: t0 + 2, expiresAtMs: null, requestId: "u1" },
  ];
  expect(spendableMicroGbp(sources, expireAt - 1)).toBe(14);
  expect(spendableMicroGbp(sources, expireAt)).toBe(7);
  const residuals = expiredGrantResiduals(sources, expireAt);
  expect(residuals).toEqual([{ grantId: "g1", grantRequestId: "g1", residualMicroGbp: 7 }]);
});

it("same-millisecond usage still consumes the grant (credits before debits)", () => {
  const t0 = Date.UTC(2024, 0, 1);
  const sources: CreditLotSource[] = [
    { id: "zzz-usage", kind: "usage", amountMicroGbp: -4, createdAtMs: t0, expiresAtMs: null, requestId: "u" },
    { id: "aaa-grant", kind: "grant", amountMicroGbp: 10, createdAtMs: t0, expiresAtMs: null, requestId: "g" },
  ];
  expect(spendableMicroGbp(sources, t0)).toBe(6);
});

it("later usage cannot consume an already-expired lot (review reproduction)", () => {
  const gOld: CreditLotSource = {
    id: "g_old", kind: "grant", amountMicroGbp: 10,
    createdAtMs: Date.UTC(2024, 0, 1), expiresAtMs: Date.UTC(2025, 0, 1), requestId: "g_old",
  };
  const gNew: CreditLotSource = {
    id: "g_new", kind: "grant", amountMicroGbp: 10,
    createdAtMs: Date.UTC(2025, 0, 1), expiresAtMs: Date.UTC(2026, 0, 1), requestId: "g_new",
  };
  const uLater: CreditLotSource = {
    id: "u_later", kind: "usage", amountMicroGbp: -7,
    createdAtMs: Date.UTC(2025, 0, 2), expiresAtMs: null, requestId: "u_later",
  };
  const sources = [gOld, gNew, uLater];
  expect(spendableMicroGbp(sources, Date.UTC(2025, 0, 3))).toBe(3);
  expect(expiredGrantResiduals(sources, Date.UTC(2025, 0, 3))).toEqual([
    { grantId: "g_old", grantRequestId: "g_old", residualMicroGbp: 10 },
  ]);
});

it("usage exactly at expiry cannot consume the expiring lot", () => {
  const expireAt = Date.UTC(2025, 0, 1);
  const sources: CreditLotSource[] = [
    { id: "g1", kind: "grant", amountMicroGbp: 10, createdAtMs: Date.UTC(2024, 0, 1), expiresAtMs: expireAt, requestId: "g1" },
    { id: "g2", kind: "grant", amountMicroGbp: 5, createdAtMs: Date.UTC(2024, 6, 1), expiresAtMs: Date.UTC(2026, 0, 1), requestId: "g2" },
    { id: "u1", kind: "usage", amountMicroGbp: -4, createdAtMs: expireAt, expiresAtMs: null, requestId: "u1" },
  ];
  expect(spendableMicroGbp(sources, expireAt)).toBe(1);
  expect(expiredGrantResiduals(sources, expireAt)).toEqual([
    { grantId: "g1", grantRequestId: "g1", residualMicroGbp: 10 },
  ]);
});

it("usage before expiry consumes the older lot FIFO", () => {
  const expireAt = Date.UTC(2025, 0, 1);
  const sources: CreditLotSource[] = [
    { id: "g1", kind: "grant", amountMicroGbp: 10, createdAtMs: Date.UTC(2024, 0, 1), expiresAtMs: expireAt, requestId: "g1" },
    { id: "g2", kind: "grant", amountMicroGbp: 10, createdAtMs: Date.UTC(2024, 6, 1), expiresAtMs: Date.UTC(2026, 0, 1), requestId: "g2" },
    { id: "u1", kind: "usage", amountMicroGbp: -7, createdAtMs: Date.UTC(2024, 11, 1), expiresAtMs: null, requestId: "u1" },
  ];
  expect(spendableMicroGbp(sources, Date.UTC(2024, 11, 2))).toBe(13);
  expect(spendableMicroGbp(sources, expireAt)).toBe(10);
  expect(expiredGrantResiduals(sources, expireAt)).toEqual([
    { grantId: "g1", grantRequestId: "g1", residualMicroGbp: 3 },
  ]);
});

it("expire audit rows do not double-consume after residuals are written", () => {
  const expireAt = Date.UTC(2025, 0, 1);
  const sources: CreditLotSource[] = [
    { id: "g_old", kind: "grant", amountMicroGbp: 10, createdAtMs: Date.UTC(2024, 0, 1), expiresAtMs: expireAt, requestId: "g_old" },
    { id: "g_new", kind: "grant", amountMicroGbp: 10, createdAtMs: Date.UTC(2025, 0, 1), expiresAtMs: Date.UTC(2026, 0, 1), requestId: "g_new" },
    { id: "u_later", kind: "usage", amountMicroGbp: -7, createdAtMs: Date.UTC(2025, 0, 2), expiresAtMs: null, requestId: "u_later" },
    {
      id: "ex1", kind: "expire", amountMicroGbp: -10, createdAtMs: Date.UTC(2025, 0, 3),
      expiresAtMs: null, requestId: "expire:g_old",
    },
  ];
  expect(spendableMicroGbp(sources, Date.UTC(2025, 0, 3))).toBe(3);
  expect(expiredGrantResiduals(sources, Date.UTC(2025, 0, 3))).toEqual([]);
});
