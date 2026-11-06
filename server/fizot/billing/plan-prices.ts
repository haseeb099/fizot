/**
 * Plan prices are data. publication stays "unpublished" until
 * scripts/fizot/margin-check.mjs passes against figures verified from the
 * provider price page and the Fly price page. Checkout refuses an unpublished
 * plan outside test mode.
 */
import { PLAN_INCLUDED_MICRO_GBP } from "../proxy/pricing.ts";

export type PlanPublication = "unpublished" | "published";

export type PlanPrice = {
  plan: "home" | "team";
  publication: PlanPublication;
  /** Not verified against a Stripe Price or a provider price page. */
  priceStatus: "unverified";
  currency: "gbp";
  /** Integer pence per billing period. Team is per seat; the owner is a seat. */
  unitAmountMinor: number;
  includedCreditMicroGbp: number;
  stripePriceId: string;
  seats: "flat" | "per_seat";
};

export const PLAN_PRICES: readonly PlanPrice[] = [
  {
    plan: "home",
    publication: "unpublished",
    priceStatus: "unverified",
    currency: "gbp",
    unitAmountMinor: 1_999,
    includedCreditMicroGbp: PLAN_INCLUDED_MICRO_GBP.home,
    stripePriceId: "price_unpublished_home",
    seats: "flat",
  },
  {
    plan: "team",
    publication: "unpublished",
    priceStatus: "unverified",
    currency: "gbp",
    unitAmountMinor: 2_499,
    includedCreditMicroGbp: PLAN_INCLUDED_MICRO_GBP.team,
    stripePriceId: "price_unpublished_team",
    seats: "per_seat",
  },
];

export function planPrice(plan: string): PlanPrice | null {
  return PLAN_PRICES.find((row) => row.plan === plan) ?? null;
}

export function billingTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || env.FIZOT_BILLING_MODE === "test";
}

/** Non-UK checkout needs a business VAT ID. EU consumers are out of scope. */
export function vatGate(country: string, vatId: string): "ok" | "vat_id_required" {
  if (country.toUpperCase() === "GB") return "ok";
  if (!vatId.trim()) return "vat_id_required";
  return "ok";
}
