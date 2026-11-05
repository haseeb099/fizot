#!/usr/bin/env node
/**
 * Compare Fizot ledger totals with a provider usage fixture.
 * Real provider APIs are out of scope; pass a JSON file:
 * { "period": "2026-11", "ledgerMicroGbp": 1000000, "providerMicroGbp": 1005000 }
 * Exits 0 when drift is within 1%, else 1. Prints no prompts and no keys.
 */
import { readFileSync } from "node:fs";
import { formatReconcile, reconcileLedger } from "../../server/fizot/proxy/reconcile.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --experimental-strip-types scripts/fizot/ledger-reconcile.mjs <fixture.json>");
  process.exit(2);
}
const input = JSON.parse(readFileSync(file, "utf8"));
const result = reconcileLedger({
  period: String(input.period ?? ""),
  ledgerMicroGbp: input.ledgerMicroGbp,
  providerMicroGbp: input.providerMicroGbp,
});
console.log(formatReconcile(result));
process.exit(result.ok ? 0 : 1);
