#!/usr/bin/env node
/**
 * S2.10: read artifacts/s2-10/awake-*.json and asleep-*.json, print the cost table.
 * Does not call Fly. Never logs secrets.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCostSheet,
  formatCostSheetTable,
  priceFloorGbp,
} from "../../server/fizot/cost-sheet.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "artifacts", "s2-10");
const SOURCE_RUN = process.env.S2_10_SOURCE_RUN
  ?? "https://github.com/haseeb099/fizot/actions/runs/41792947703";

function loadProbe(prefix) {
  const name = readdirSync(DIR).find((f) => f.startsWith(prefix) && f.endsWith(".json"));
  if (!name) throw new Error(`no ${prefix}*.json in ${DIR}`);
  return JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
}

const awake = loadProbe("awake-");
const asleep = loadProbe("asleep-");
const sheet = buildCostSheet({ awake, asleep, sourceRun: SOURCE_RUN });

console.log(formatCostSheetTable(sheet));
console.log("");
console.log("AI cost (separate; proxy pass-through, no markup assumed yet):");
console.log("  measured_model_usd_per_customer_month: not measured on this probe");
console.log("  assumed_passthrough_markup: 0");
console.log("  note: set plan price after proxy ledger numbers exist (S2.9 / P4.4)");
console.log("");
const always = sheet.profiles.find((p) => p.id === "always_on");
if (always) {
  console.log(`price floor at always-on Fly+egress+volume (excl. AI): £${priceFloorGbp(always.totalUsd)} (formula from S2.10; AI not included)`);
}
console.log(JSON.stringify({ ok: true, dir: DIR, totals: Object.fromEntries(sheet.profiles.map((p) => [p.id, p.totalUsd])) }));
