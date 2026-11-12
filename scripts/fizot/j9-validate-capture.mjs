#!/usr/bin/env node
/**
 * Validate schema-v2 webhook-capture.json without printing delivery bodies.
 * Exit 0 on ok; non-zero with a short reason only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), process.argv[2] ?? "artifacts/j9/webhook-capture.json");
let raw;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.error("j9_validate_capture FAIL reason=unreadable_or_invalid_json");
  process.exit(2);
}
if (raw.schemaVersion !== 2 || raw.kind !== "stripe_cli_signed_capture") {
  console.error("j9_validate_capture FAIL reason=schema");
  process.exit(2);
}
if (typeof raw.runId !== "string" || !raw.runId.startsWith("j9run_")) {
  console.error("j9_validate_capture FAIL reason=runId");
  process.exit(2);
}
if (!Array.isArray(raw.deliveries) || raw.deliveries.length < 1) {
  console.error("j9_validate_capture FAIL reason=deliveries");
  process.exit(2);
}
const types = new Set();
for (const d of raw.deliveries) {
  if (typeof d.body !== "string" || !d.body) {
    console.error("j9_validate_capture FAIL reason=body");
    process.exit(2);
  }
  if (typeof d.stripeSignatureHeader !== "string" || !d.stripeSignatureHeader.includes("v1=")) {
    console.error("j9_validate_capture FAIL reason=sig");
    process.exit(2);
  }
  if (d.body.includes("sk_test_") || d.body.includes("sk_live_") || d.body.includes("whsec_")) {
    console.error("j9_validate_capture FAIL reason=secret_material");
    process.exit(2);
  }
  try {
    types.add(JSON.parse(d.body).type);
  } catch {
    console.error("j9_validate_capture FAIL reason=body_not_json_event");
    process.exit(2);
  }
}
console.log(`j9_validate_capture ok runId=${raw.runId} deliveries=${raw.deliveries.length} types=${[...types].sort().join(",")}`);
