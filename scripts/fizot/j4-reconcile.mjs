#!/usr/bin/env node
/**
 * Read-only J4 reconciliation CLI.
 * Compares provider-cost evidence to Fizot-computed provider cost.
 * Never charges, refunds, or releases holds. Prints no prompts or keys.
 *
 * Input JSON:
 * {
 *   "period": "2026-11",
 *   "provider": "xai",
 *   "evidenceComplete": false,
 *   "comparisonBasis": "provider_cost_vs_fizot_provider_cost",
 *   "providerRows": [...],
 *   "ledgerRows": [...],
 *   "openHolds": [...]
 * }
 */
import { readFileSync } from "node:fs";
import { formatJ4Report, reconcileJ4 } from "../../server/fizot/proxy/j4-reconcile.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --experimental-strip-types scripts/fizot/j4-reconcile.mjs <export.json>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(file, "utf8"));
const report = reconcileJ4({
  period: String(input.period ?? ""),
  provider: String(input.provider ?? "unknown"),
  comparisonBasis: input.comparisonBasis ?? "provider_cost_vs_fizot_provider_cost",
  evidenceComplete: Boolean(input.evidenceComplete),
  providerRows: Array.isArray(input.providerRows) ? input.providerRows : [],
  ledgerRows: Array.isArray(input.ledgerRows) ? input.ledgerRows : [],
  openHolds: Array.isArray(input.openHolds) ? input.openHolds : [],
  maxDrift: input.maxDrift,
});

console.log(formatJ4Report(report));
console.log(JSON.stringify({
  verdict: report.verdict,
  drift: report.drift,
  withinThreshold: report.withinThreshold,
  matched: report.matched.length,
  unmatchedProvider: report.unmatchedProvider.length,
  unmatchedLedger: report.unmatchedLedger.length,
  duplicateProviderIds: report.duplicateProviderIds,
  duplicateLedgerIds: report.duplicateLedgerIds,
  openHolds: report.openHolds.length,
  providerCostTotalMicro: report.providerCostTotalMicro,
  fizotProviderCostTotalMicro: report.fizotProviderCostTotalMicro,
  customerChargeTotalMicroGbp: report.customerChargeTotalMicroGbp,
  reasons: report.reasons,
}, null, 2));

if (report.verdict === "PASS") process.exit(0);
if (report.verdict === "INSUFFICIENT_EVIDENCE") process.exit(3);
process.exit(1);
