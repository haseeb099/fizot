#!/usr/bin/env node
/**
 * Gross margin per plan and Fly usage profile.
 * Exits 1 when a published plan is under 40% at always-on with included credit fully used.
 * Unpublished prices are printed and do not fail the gate.
 */
import { readFileSync } from "node:fs";
import { evaluateMargins, formatMarginReport } from "../../server/fizot/billing/margin.ts";
import { PLAN_PRICES } from "../../server/fizot/billing/plan-prices.ts";
import { TIER_PRICES } from "../../server/fizot/proxy/pricing.ts";

const sheet = readFileSync(new URL("../../docs/fizot/cost-sheet.md", import.meta.url), "utf8");
const report = evaluateMargins({ sheet, plans: PLAN_PRICES, tiers: TIER_PRICES });
console.log(formatMarginReport(report));
process.exit(report.ok ? 0 : 1);
