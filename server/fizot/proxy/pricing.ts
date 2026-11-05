/**
 * Tier prices are data. Figures are placeholders and have not been checked
 * against a provider price page. Customers see tier names only.
 */
export const TIER_IDS = ["fast", "balanced", "best"] as const;
export type TierId = (typeof TIER_IDS)[number];

export type TierPrice = {
  tier: TierId;
  displayName: "Fast" | "Balanced" | "Best";
  /** Internal. Never returned to a customer or written into an error body. */
  provider: string;
  /** Internal model id. Never returned to a customer. */
  model: string;
  /** Placeholder until the number is read off the provider's price page. */
  priceStatus: "placeholder_unverified";
  inputMicroGbpPerMillion: number;
  outputMicroGbpPerMillion: number;
  /** Markup in basis points applied on top of the provider unit price. */
  markupBps: number;
};

export const TIER_PRICES: readonly TierPrice[] = [
  {
    tier: "fast",
    displayName: "Fast",
    provider: "xai",
    model: "grok-4-fast",
    priceStatus: "placeholder_unverified",
    inputMicroGbpPerMillion: 200_000,
    outputMicroGbpPerMillion: 800_000,
    markupBps: 2_000,
  },
  {
    tier: "balanced",
    displayName: "Balanced",
    provider: "xai",
    model: "grok-4",
    priceStatus: "placeholder_unverified",
    inputMicroGbpPerMillion: 800_000,
    outputMicroGbpPerMillion: 3_200_000,
    markupBps: 2_000,
  },
  {
    tier: "best",
    displayName: "Best",
    provider: "xai",
    model: "grok-4-heavy",
    priceStatus: "placeholder_unverified",
    inputMicroGbpPerMillion: 2_000_000,
    outputMicroGbpPerMillion: 8_000_000,
    markupBps: 2_000,
  },
];

/** Plan included credit for the monthly 80% alert. Not a published price. */
export const PLAN_INCLUDED_MICRO_GBP: Record<"home" | "team", number> = {
  home: 5_000_000,
  team: 20_000_000,
};

export function isTierId(value: string): value is TierId {
  return (TIER_IDS as readonly string[]).includes(value);
}

export function tierPrice(tier: TierId, table: readonly TierPrice[] = TIER_PRICES): TierPrice {
  const row = table.find((item) => item.tier === tier);
  if (!row) throw new Error(`tier ${tier} has no price`);
  if (!Number.isInteger(row.inputMicroGbpPerMillion) || row.inputMicroGbpPerMillion < 0) {
    throw new Error(`tier ${tier} input price missing`);
  }
  if (!Number.isInteger(row.outputMicroGbpPerMillion) || row.outputMicroGbpPerMillion < 0) {
    throw new Error(`tier ${tier} output price missing`);
  }
  if (!Number.isInteger(row.markupBps) || row.markupBps < 0) {
    throw new Error(`tier ${tier} markup missing`);
  }
  return row;
}

/** Ceiling of tokens × unit price × (1 + markup), in micro-GBP. Integers only. */
export function tokensToMicroGbp(tokens: number, microGbpPerMillion: number, markupBps: number): number {
  if (!Number.isInteger(tokens) || tokens < 0) throw new Error("token count must be a non-negative integer");
  if (!Number.isInteger(microGbpPerMillion) || microGbpPerMillion < 0) throw new Error("price must be a non-negative integer");
  if (!Number.isInteger(markupBps) || markupBps < 0) throw new Error("markup must be a non-negative integer");
  if (tokens === 0 || microGbpPerMillion === 0) return 0;
  const num = BigInt(tokens) * BigInt(microGbpPerMillion) * BigInt(10_000 + markupBps);
  const den = 1_000_000n * 10_000n;
  return Number((num + den - 1n) / den);
}

export function quoteMicroGbp(input: {
  tier: TierId;
  inputTokens: number;
  outputTokens: number;
  table?: readonly TierPrice[];
}): { inputMicroGbp: number; outputMicroGbp: number; totalMicroGbp: number } {
  const price = tierPrice(input.tier, input.table);
  const inputMicroGbp = tokensToMicroGbp(input.inputTokens, price.inputMicroGbpPerMillion, price.markupBps);
  const outputMicroGbp = tokensToMicroGbp(input.outputTokens, price.outputMicroGbpPerMillion, price.markupBps);
  return { inputMicroGbp, outputMicroGbp, totalMicroGbp: inputMicroGbp + outputMicroGbp };
}

export function assertPriceTableComplete(table: readonly TierPrice[] = TIER_PRICES): void {
  for (const tier of TIER_IDS) tierPrice(tier, table);
}
