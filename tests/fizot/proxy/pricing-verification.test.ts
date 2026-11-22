import { expect, it } from "vitest";
import { TIER_IDS, TIER_PRICES, quoteMicroGbp, tokensToMicroGbp } from "../../../server/fizot/proxy/pricing.ts";
import {
  OBSERVED_GROK_43_SHORT_CONTEXT_USD,
  PROVIDER_PRICE_OBSERVATIONS,
  assertAllTierObserved,
  observationForTier,
  quoteProviderCostMicroUsd,
  tokensToMicroUsd,
} from "../../../server/fizot/proxy/pricing-verification.ts";

it("records an observation for every customer tier without claiming verified prices", () => {
  assertAllTierObserved();
  expect(PROVIDER_PRICE_OBSERVATIONS).toHaveLength(TIER_IDS.length);
  for (const tier of TIER_IDS) {
    const observed = observationForTier(tier);
    const price = TIER_PRICES.find((row) => row.tier === tier)!;
    expect(observed.internalModel).toBe(price.model);
    expect(observed.status).not.toBe("verified");
    expect(price.priceStatus).toBe("placeholder_unverified");
  }
});

it("keeps observed grok-4.3 short-context USD rates from the verification source", () => {
  expect(OBSERVED_GROK_43_SHORT_CONTEXT_USD.model).toBe("grok-4.3");
  expect(OBSERVED_GROK_43_SHORT_CONTEXT_USD.inputUsdPerMillion).toBe(1.25);
  expect(OBSERVED_GROK_43_SHORT_CONTEXT_USD.outputUsdPerMillion).toBe(2.5);
  expect(OBSERVED_GROK_43_SHORT_CONTEXT_USD.cachedInputUsdPerMillion).toBe(0.2);
  expect(OBSERVED_GROK_43_SHORT_CONTEXT_USD.sourceUrl).toContain("docs.x.ai");
});

it("computes provider micro-USD with ceiling integer arithmetic", () => {
  // $1.25 / 1M → 1_250_000 micro-USD per million tokens; 1 token → ceil(1.25) = 2 micro-USD
  expect(tokensToMicroUsd(1, 1.25)).toBe(2);
  expect(tokensToMicroUsd(1_000_000, 1.25)).toBe(1_250_000);
  expect(tokensToMicroUsd(0, 1.25)).toBe(0);
  expect(() => tokensToMicroUsd(-1, 1.25)).toThrow(/non-negative/);
  expect(() => tokensToMicroUsd(1, 0)).toThrow(/positive/);
});

it("quotes provider cost separately from customer markup charges", () => {
  const provider = quoteProviderCostMicroUsd({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    inputUsdPerMillion: OBSERVED_GROK_43_SHORT_CONTEXT_USD.inputUsdPerMillion,
    outputUsdPerMillion: OBSERVED_GROK_43_SHORT_CONTEXT_USD.outputUsdPerMillion,
  });
  expect(provider.totalMicroUsd).toBe(1_250_000 + 2_500_000);

  const customer = quoteMicroGbp({ tier: "fast", inputTokens: 1_000_000, outputTokens: 1_000_000 });
  // Customer charge uses placeholder GBP + markup; must not equal provider USD.
  expect(customer.totalMicroGbp).toBe(
    tokensToMicroGbp(1_000_000, 200_000, 2_000) + tokensToMicroGbp(1_000_000, 800_000, 2_000),
  );
  expect(customer.totalMicroGbp).not.toBe(provider.totalMicroUsd);
});

it("rounds currency conversion boundaries deterministically", () => {
  // 1 token at $0.000001 / token equivalent ($1 / 1M) → 1 micro-USD
  expect(tokensToMicroUsd(1, 1)).toBe(1);
  // Fractional micro-USD ceilings: $0.5 / 1M → 500_000 micro-USD/M; 1 token → 1
  expect(tokensToMicroUsd(1, 0.5)).toBe(1);
  expect(tokensToMicroUsd(2, 0.5)).toBe(1);
});

it("rejects verified observations that still leave customer prices as placeholders", () => {
  const verifiedObs = PROVIDER_PRICE_OBSERVATIONS.map((row) =>
    row.tier === "fast"
      ? {
        ...row,
        status: "verified" as const,
        observedProviderModel: "grok-4.3",
        observedInputUsdPerMillion: 1.25,
        observedOutputUsdPerMillion: 2.5,
      }
      : row
  );
  expect(() => assertAllTierObserved(TIER_PRICES, verifiedObs)).toThrow(/placeholder_unverified/);
});
