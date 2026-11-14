#!/usr/bin/env node
/**
 * Import a signed J9 capture from a temporary encrypted GitHub Actions secret.
 * The operator sets STRIPE_J9_CAPTURE_JSON from the local capture file.
 * Never print its contents, signatures, or secret value.
 *
 * This is only a transport path: resume still verifies webhook signatures,
 * Stripe Event API origin, and same-run ownership independently.
 */
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { J9_WEBHOOK_CAPTURE_RELATIVE } from "../../server/fizot/billing/j9-capture-policy.ts";
import { J9_CAPTURE_MAX_BYTES, writeRestrictedFile } from "../../server/fizot/billing/j9-capture-transfer.ts";
import { loadWebhookCapture } from "../../server/fizot/billing/j9-webhook-capture.ts";

const raw = process.env.STRIPE_J9_CAPTURE_JSON ?? "";
const bytes = Buffer.byteLength(raw, "utf8");
if (bytes === 0 || bytes > J9_CAPTURE_MAX_BYTES) {
  console.error("j9_import_capture BLOCKED reason=empty_or_oversized_capture_secret");
  process.exit(2);
}

const path = resolve(process.cwd(), J9_WEBHOOK_CAPTURE_RELATIVE);
try {
  // A fresh Actions checkout is expected. Never print the source or fallback
  // to a repository file if the input is absent/invalid.
  writeRestrictedFile(path, raw.endsWith("\n") ? raw : `${raw}\n`);
  const loaded = loadWebhookCapture(path);
  if (!loaded.ok) {
    throw new Error("invalid_capture");
  }
  console.log(`j9_import_capture ok bytes=${bytes} path=artifacts/j9/webhook-capture.json`);
} catch {
  try { unlinkSync(path); } catch { /* absent is fine */ }
  console.error("j9_import_capture BLOCKED reason=invalid_or_unwritable_capture_secret");
  process.exit(2);
}
