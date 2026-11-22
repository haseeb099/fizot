/**
 * Provider price verification records for Fizot proxy tiers.
 * Does not change customer charge tables; those stay in pricing.ts until
 * an operator-approved verified rate and FX basis are chosen.
 */

import { TIER_PRICES, type TierId, type TierPrice } from "./pricing.ts";

export type PriceVerificationStatus =
  | "placeholder_unverified"
  | "mismatched_unverified"
  | "verified";

export type ProviderPriceObservation = {
  tier: TierId;
  internalModel: string;
  /** Model id on the provider price page, if any. */
  observedProviderModel: string | null;
  /** USD per 1M input tokens from the provider page, short-context row when dual. */
  observedInputUsdPerMillion: number | null;
  observedOutputUsdPerMillion: number | null;
  observedCachedInputUsdPerMillion: number | null;
  sourceUrl: string;
  verifiedAtUtc: string;
  notes: string;
  status: PriceVerificationStatus;
};

/** Read 2026-11-19 from https://docs.x.ai/developers/pricing (live catalog). */
export const XAI_PRICING_SOURCE_URL = "https://docs.x.ai/developers/pricing";
export const XAI_RETIREMENT_SOURCE_URL =
  "https://docs.x.ai/developers/migration/may-15-retirement";

/**
 * Observations against live xAI docs. Internal slugs `grok-4-fast`, `grok-4`,
 * and `grok-4-heavy` are not listed on the live text API table; retired Grok 4
 * family slugs redirect to `grok-4.3` after 2026-05-15. Customer micro-GBP
 * placeholders are therefore mismatched/unverified — not silently updated.
 */
export const PROVIDER_PRICE_OBSERVATIONS: readonly ProviderPriceObservation[] = [
  {
    tier: "fast",
    internalModel: "grok-4-fast",
    observedProviderModel: null,
    observedInputUsdPerMillion: null,
    observedOutputUsdPerMillion: null,
    observedCachedInputUsdPerMillion: null,
    sourceUrl: XAI_PRICING_SOURCE_URL,
    verifiedAtUtc: "2026-11-19T00:00:00.000Z",
    notes:
      "No live `grok-4-fast` row. Retired `grok-4-fast-*` slugs redirect to grok-4.3 ($1.25/$2.50 per 1M short-context). Placeholder customer rates remain UNVERIFIED.",
    status: "mismatched_unverified",
  },
  {
    tier: "balanced",
    internalModel: "grok-4",
    observedProviderModel: null,
    observedInputUsdPerMillion: null,
    observedOutputUsdPerMillion: null,
    observedCachedInputUsdPerMillion: null,
    sourceUrl: XAI_PRICING_SOURCE_URL,
    verifiedAtUtc: "2026-11-19T00:00:00.000Z",
    notes:
      "No live `grok-4` / `grok-4-0709` row on the pricing table. Retirement doc bills redirects at grok-4.3. Placeholder customer rates remain UNVERIFIED.",
    status: "mismatched_unverified",
  },
  {
    tier: "best",
    internalModel: "grok-4-heavy",
    observedProviderModel: null,
    observedInputUsdPerMillion: null,
    observedOutputUsdPerMillion: null,
    observedCachedInputUsdPerMillion: null,
    sourceUrl: XAI_PRICING_SOURCE_URL,
    verifiedAtUtc: "2026-11-19T00:00:00.000Z",
    notes:
      "No `grok-4-heavy` listing on the live xAI text API pricing page. Placeholder customer rates remain UNVERIFIED.",
    status: "mismatched_unverified",
  },
];

/** Live short-context grok-4.3 rates from the same verification date (USD). */
export const OBSERVED_GROK_43_SHORT_CONTEXT_USD = {
  model: "grok-4.3",
  inputUsdPerMillion: 1.25,
  cachedInputUsdPerMillion: 0.2,
  outputUsdPerMillion: 2.5,
  longContextThresholdTokens: 200_000,
  longInputUsdPerMillion: 2.5,
  longCachedInputUsdPerMillion: 0.4,
  longOutputUsdPerMillion: 5.0,
  sourceUrl: XAI_PRICING_SOURCE_URL,
  verifiedAtUtc: "2026-11-19T00:00:00.000Z",
} as const;

export function observationForTier(tier: TierId): ProviderPriceObservation {
  const row = PROVIDER_PRICE_OBSERVATIONS.find((item) => item.tier === tier);
  if (!row) throw new Error(`no price observation for ${tier}`);
  return row;
}

export function assertAllTierObserved(
  table: readonly TierPrice[] = TIER_PRICES,
  observations: readonly ProviderPriceObservation[] = PROVIDER_PRICE_OBSERVATIONS,
): void {
  for (const price of table) {
    const observed = observations.find((item) => item.tier === price.tier);
    if (!observed) throw new Error(`no price observation for ${price.tier}`);
    if (observed.internalModel !== price.model) {
      throw new Error(`observation model mismatch for ${price.tier}`);
    }
    if (observed.status === "verified") {
      if (observed.observedProviderModel == null) {
        throw new Error(`tier ${price.tier} verified observation missing provider model`);
      }
      if (
        observed.observedInputUsdPerMillion == null
        || observed.observedOutputUsdPerMillion == null
      ) {
        throw new Error(`tier ${price.tier} verified observation missing rates`);
      }
      if (price.priceStatus === "placeholder_unverified") {
        throw new Error(
          `tier ${price.tier} observation is verified but customer price remains placeholder_unverified`,
        );
      }
    }
  }
  for (const observed of observations) {
    if (
      observed.status !== "verified"
      && observed.status !== "mismatched_unverified"
      && observed.status !== "placeholder_unverified"
    ) {
      throw new Error(`tier ${observed.tier} has unknown observation status`);
    }
  }
}

/**
 * Provider cost in micro-USD (integers). Used for J4 provider-side comparison.
 * Does not apply customer markup and does not convert to GBP (FX is operator-supplied).
 */
export function tokensToMicroUsd(
  tokens: number,
  usdPerMillion: number,
): number {
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error("token count must be a non-negative integer");
  if (!(usdPerMillion > 0) || !Number.isFinite(usdPerMillion)) {
    throw new Error("usdPerMillion must be a positive finite number");
  }
  if (tokens === 0) return 0;
  // micro-USD = tokens * (usdPerMillion * 1e6) / 1e6 = tokens * usdPerMillion * 1e6 / 1e6
  // Represent usdPerMillion as micro-USD per million tokens: $1.25 → 1_250_000 micro-USD / 1M tokens.
  const microUsdPerMillion = Math.round(usdPerMillion * 1_000_000);
  if (!Number.isSafeInteger(microUsdPerMillion) || microUsdPerMillion <= 0) {
    throw new Error("usdPerMillion not representable as safe micro-USD");
  }
  const num = BigInt(tokens) * BigInt(microUsdPerMillion);
  const den = 1_000_000n;
  return Number((num + den - 1n) / den);
}

export function quoteProviderCostMicroUsd(input: {
  inputTokens: number;
  outputTokens: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}): { inputMicroUsd: number; outputMicroUsd: number; totalMicroUsd: number } {
  const inputMicroUsd = tokensToMicroUsd(input.inputTokens, input.inputUsdPerMillion);
  const outputMicroUsd = tokensToMicroUsd(input.outputTokens, input.outputUsdPerMillion);
  return {
    inputMicroUsd,
    outputMicroUsd,
    totalMicroUsd: inputMicroUsd + outputMicroUsd,
  };
}
