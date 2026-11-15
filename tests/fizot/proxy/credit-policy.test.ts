import { expect, it } from "vitest";
import {
  addUtcCalendarMonths,
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
