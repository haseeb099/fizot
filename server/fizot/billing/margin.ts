import type { PlanPrice } from "./plan-prices.ts";
import type { TierPrice } from "../proxy/pricing.ts";

export type UsageProfile = { name: string; flyGbp: number };

export type MarginRow = {
  plan: string;
  profile: string;
  seats: number;
  revenueMinor: number;
  flyGbp: number;
  includedMicroGbp: number;
  providerMicroGbp: number;
  revenueMicroGbp: number;
  costMicroGbp: number;
  margin: number;
  published: boolean;
  verified: boolean;
  belowFloor: boolean;
};

export type MarginReport = { rows: MarginRow[]; ok: boolean };

const FLOOR = 0.4;

export function providerCostMicro(includedMicroGbp: number, markupBps: number): number {
  return Math.floor((includedMicroGbp * 10_000) / (10_000 + markupBps));
}

export function parseFlyProfiles(sheet: string): UsageProfile[] {
  const profiles: UsageProfile[] = [];
  for (const line of sheet.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const name = cells[1]?.replace(/\*\*/g, "");
    if (name !== "Always on" && name !== "8 h/day awake" && name !== "Mostly asleep") continue;
    const amounts = [...line.matchAll(/£([0-9]+(?:\.[0-9]+)?)/g)];
    const flyGbp = Number(amounts.at(-1)?.[1] ?? "");
    if (!Number.isFinite(flyGbp)) continue;
    profiles.push({ name: name === "Always on" ? "always-on" : name === "8 h/day awake" ? "8h" : "asleep", flyGbp });
  }
  return profiles;
}

export function worstMarkupBps(tiers: readonly TierPrice[]): number {
  return tiers.reduce((min, row) => Math.min(min, row.markupBps), tiers[0]?.markupBps ?? 0);
}

/** Gross margin at `seats` (team worst case is 1: the owner) with included credit fully used. */
export function marginFor(input: {
  price: PlanPrice;
  profile: UsageProfile;
  seats: number;
  markupBps: number;
}): MarginRow {
  const revenueMinor = input.price.unitAmountMinor * input.seats;
  const revenueMicroGbp = revenueMinor * 10_000;
  const flyMicro = Math.round(input.profile.flyGbp * 1_000_000);
  const providerMicroGbp = providerCostMicro(input.price.includedCreditMicroGbp, input.markupBps);
  const costMicroGbp = flyMicro + providerMicroGbp;
  const margin = revenueMicroGbp === 0 ? -1 : (revenueMicroGbp - costMicroGbp) / revenueMicroGbp;
  const published = input.price.publication === "published";
  const belowFloor = published && input.profile.name === "always-on" && margin < FLOOR;
  return {
    plan: input.price.plan,
    profile: input.profile.name,
    seats: input.seats,
    revenueMinor,
    flyGbp: input.profile.flyGbp,
    includedMicroGbp: input.price.includedCreditMicroGbp,
    providerMicroGbp,
    revenueMicroGbp,
    costMicroGbp,
    margin,
    published,
    verified: false,
    belowFloor,
  };
}

export function evaluateMargins(input: {
  sheet: string;
  plans: readonly PlanPrice[];
  tiers: readonly TierPrice[];
}): MarginReport {
  const profiles = parseFlyProfiles(input.sheet);
  const markupBps = worstMarkupBps(input.tiers);
  const rows: MarginRow[] = [];
  for (const price of input.plans) {
    const seats = price.seats === "per_seat" ? 1 : 1;
    for (const profile of profiles) rows.push(marginFor({ price, profile, seats, markupBps }));
  }
  return { rows, ok: rows.every((row) => !row.belowFloor) };
}

export function formatMarginReport(report: MarginReport): string {
  const lines = report.rows.map((row) =>
    `margin plan=${row.plan} profile=${row.profile} seats=${row.seats} revenueMinor=${row.revenueMinor} flyGbp=${row.flyGbp} includedMicro=${row.includedMicroGbp} providerMicro=${row.providerMicroGbp} margin=${row.margin.toFixed(4)} published=${row.published} verified=${row.verified}`,
  );
  lines.push(`margin_ok=${report.ok}`);
  return lines.join("\n");
}
