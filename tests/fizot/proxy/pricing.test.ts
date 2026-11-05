import { expect, it } from "vitest";
import {
  TIER_IDS,
  TIER_PRICES,
  assertPriceTableComplete,
  quoteMicroGbp,
  tierPrice,
  tokensToMicroGbp,
} from "../../../server/fizot/proxy/pricing.ts";

it("every tier has an integer price and a markup (PX-U)", () => {
  expect(TIER_IDS).toEqual(["fast", "balanced", "best"]);
  assertPriceTableComplete(TIER_PRICES);
  for (const tier of TIER_IDS) {
    const row = tierPrice(tier);
    expect(row.priceStatus).toBe("placeholder_unverified");
    expect(row.inputMicroGbpPerMillion).toBeGreaterThan(0);
    expect(row.outputMicroGbpPerMillion).toBeGreaterThan(0);
    expect(row.markupBps).toBeGreaterThan(0);
    expect(row.displayName).not.toBe(row.provider);
    expect(row.displayName).not.toBe(row.model);
  }
  expect(() => tierPrice("fast", [])).toThrow(/no price/);
});

it("prices money in integers and applies markup", () => {
  expect(tokensToMicroGbp(1_000_000, 200_000, 2_000)).toBe(240_000);
  expect(tokensToMicroGbp(0, 200_000, 2_000)).toBe(0);
  const quote = quoteMicroGbp({ tier: "fast", inputTokens: 1_000_000, outputTokens: 1_000_000 });
  expect(Number.isInteger(quote.totalMicroGbp)).toBe(true);
  expect(quote.totalMicroGbp).toBeGreaterThan(0);
});
