#!/usr/bin/env node
/**
 * Pack Stripe CLI-forwarded deliveries into schema-v2 artifacts/j9/webhook-capture.json.
 *
 * Usage:
 *   node --experimental-strip-types scripts/fizot/j9-pack-webhook-capture.mjs \
 *     --run-id=j9run_… \
 *     --delivery=path/to/session.body.json,path/to/session.sig.txt \
 *     --delivery=path/to/paid.body.json,path/to/paid.sig.txt
 *
 * Each delivery is the unmodified webhook body file plus a file containing the
 * full Stripe-Signature header value. Never put API keys, whsec secrets, or
 * card PANs into these files. Output path is fixed: artifacts/j9/webhook-capture.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function argValues(name) {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function argValue(name) {
  const rows = argValues(name);
  return rows[0] ?? null;
}

const runId = argValue("run-id");
const deliveriesIn = argValues("delivery");
const provenance = argValue("provenance") ?? "stripe_cli_listen";
const outRel = join("artifacts", "j9", "webhook-capture.json");
const outPath = resolve(process.cwd(), outRel);

if (!runId || !runId.startsWith("j9run_")) {
  console.error("j9_pack_capture FAIL reason=run_id_required (j9run_…)");
  process.exit(2);
}
if (deliveriesIn.length < 1) {
  console.error("j9_pack_capture FAIL reason=delivery_required (--delivery=body.json,sig.txt)");
  process.exit(2);
}
if (!["stripe_cli_listen", "stripe_cli_trigger_forward", "historical_export"].includes(provenance)) {
  console.error("j9_pack_capture FAIL reason=provenance_invalid");
  process.exit(2);
}

const deliveries = [];
for (const row of deliveriesIn) {
  const [bodyPath, sigPath] = row.split(",");
  if (!bodyPath || !sigPath) {
    console.error(`j9_pack_capture FAIL reason=delivery_shape delivery=${row}`);
    process.exit(2);
  }
  const body = readFileSync(resolve(process.cwd(), bodyPath), "utf8");
  const stripeSignatureHeader = readFileSync(resolve(process.cwd(), sigPath), "utf8").trim();
  if (!stripeSignatureHeader.includes("v1=")) {
    console.error(`j9_pack_capture FAIL reason=signature_header_invalid file=${sigPath}`);
    process.exit(2);
  }
  if (body.includes("sk_test_") || body.includes("sk_live_") || body.includes("whsec_")) {
    console.error(`j9_pack_capture FAIL reason=body_contains_secret_material file=${bodyPath}`);
    process.exit(2);
  }
  deliveries.push({ body, stripeSignatureHeader, provenance });
}

const capture = {
  schemaVersion: 2,
  kind: "stripe_cli_signed_capture",
  runId,
  capturedAt: new Date().toISOString(),
  deliveries,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(capture, null, 2)}\n`);
console.log(`j9_pack_capture ok path=${outRel} deliveries=${deliveries.length} runId=${runId}`);
console.log("j9_pack_capture next: commit only this file on a throwaway branch, dispatch stage=upload_capture, note the Actions run id as capture_run_id, then delete the branch.");
