#!/usr/bin/env node
/**
 * Pack Stripe CLI deliveries into schema-v2 artifacts/j9/webhook-capture.json.
 *
 * Prefer the local receiver inbox:
 *   node --experimental-strip-types scripts/fizot/j9-capture-receiver.mjs
 *   stripe listen --forward-to http://127.0.0.1:18787/stripe ...
 *   node --experimental-strip-types scripts/fizot/j9-pack-webhook-capture.mjs --run-id=j9run_… --from-inbox
 *
 * Or explicit pairs:
 *   --delivery=path/to/body.json,path/to/sig.txt
 *
 * Output is gitignored (mode 0600 when the OS supports it). Never commit captures.
 * For Actions handoff: host on a short-lived HTTPS URL, set Actions secret
 * STRIPE_J9_CAPTURE_TRANSFER_URL, dispatch stage=upload_capture, then clear the secret.
 * Never use workflow_dispatch URL inputs or git commits.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeRestrictedFile } from "../../server/fizot/billing/j9-capture-transfer.ts";

function argValues(name) {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function argValue(name) {
  const rows = argValues(name);
  return rows[0] ?? null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const runId = argValue("run-id");
const provenance = argValue("provenance") ?? "stripe_cli_listen";
const outRel = join("artifacts", "j9", "webhook-capture.json");
const outPath = resolve(process.cwd(), outRel);
const inboxDir = resolve(process.cwd(), "artifacts", "j9", "inbox");

if (!runId || !runId.startsWith("j9run_")) {
  console.error("j9_pack_capture FAIL reason=run_id_required (j9run_…)");
  process.exit(2);
}
if (!["stripe_cli_listen", "stripe_cli_trigger_forward", "historical_export"].includes(provenance)) {
  console.error("j9_pack_capture FAIL reason=provenance_invalid");
  process.exit(2);
}

/** @type {Array<{ body: string, stripeSignatureHeader: string, provenance: string }>} */
const deliveries = [];

if (hasFlag("from-inbox")) {
  const files = readdirSync(inboxDir).filter((name) => name.endsWith(".body.json")).sort();
  if (files.length < 1) {
    console.error("j9_pack_capture FAIL reason=inbox_empty");
    process.exit(2);
  }
  for (const bodyName of files) {
    const base = bodyName.replace(/\.body\.json$/, "");
    const bodyPath = join(inboxDir, bodyName);
    const sigPath = join(inboxDir, `${base}.sig.txt`);
    const body = readFileSync(bodyPath, "utf8");
    const stripeSignatureHeader = readFileSync(sigPath, "utf8").trim();
    if (!stripeSignatureHeader.includes("v1=")) {
      console.error(`j9_pack_capture FAIL reason=signature_header_invalid file=${base}.sig.txt`);
      process.exit(2);
    }
    if (body.includes("sk_test_") || body.includes("sk_live_") || body.includes("whsec_")) {
      console.error("j9_pack_capture FAIL reason=body_contains_secret_material");
      process.exit(2);
    }
    deliveries.push({ body, stripeSignatureHeader, provenance });
  }
} else {
  const deliveriesIn = argValues("delivery");
  if (deliveriesIn.length < 1) {
    console.error("j9_pack_capture FAIL reason=delivery_required (--from-inbox or --delivery=body,sig)");
    process.exit(2);
  }
  for (const row of deliveriesIn) {
    const [bodyPath, sigPath] = row.split(",");
    if (!bodyPath || !sigPath) {
      console.error(`j9_pack_capture FAIL reason=delivery_shape`);
      process.exit(2);
    }
    const body = readFileSync(resolve(process.cwd(), bodyPath), "utf8");
    const stripeSignatureHeader = readFileSync(resolve(process.cwd(), sigPath), "utf8").trim();
    if (!stripeSignatureHeader.includes("v1=")) {
      console.error("j9_pack_capture FAIL reason=signature_header_invalid");
      process.exit(2);
    }
    if (body.includes("sk_test_") || body.includes("sk_live_") || body.includes("whsec_")) {
      console.error("j9_pack_capture FAIL reason=body_contains_secret_material");
      process.exit(2);
    }
    deliveries.push({ body, stripeSignatureHeader, provenance });
  }
}

const capture = {
  schemaVersion: 2,
  kind: "stripe_cli_signed_capture",
  runId,
  capturedAt: new Date().toISOString(),
  deliveries,
};

writeRestrictedFile(outPath, `${JSON.stringify(capture, null, 2)}\n`);
console.log(`j9_pack_capture ok path=${outRel} deliveries=${deliveries.length} runId=${runId}`);
console.log("j9_pack_capture next: do NOT commit this file. Local resume may use it on disk. For Actions, set secret STRIPE_J9_CAPTURE_TRANSFER_URL then stage=upload_capture; clear the secret after.");
console.log("j9_pack_capture cleanup: delete artifacts/j9/inbox, webhook-capture.json, transfer storage, and expire Actions artifacts after verification.");
