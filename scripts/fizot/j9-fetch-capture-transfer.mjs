#!/usr/bin/env node
/**
 * Fetch schema-v2 webhook-capture.json from STRIPE_J9_CAPTURE_TRANSFER_URL.
 * Never prints the URL, query string, or capture body.
 *
 * Used by Actions stage=upload_capture. The secret is a short-lived bearer URL;
 * clear it after the upload run.
 */
import { fetchCaptureFromTransferUrl, J9_CAPTURE_TRANSFER_SECRET_NAME } from "../../server/fizot/billing/j9-capture-transfer.ts";

const url = (process.env.STRIPE_J9_CAPTURE_TRANSFER_URL ?? "").trim();
if (!url) {
  console.error(`j9_fetch_capture BLOCKED reason=missing_secret name=${J9_CAPTURE_TRANSFER_SECRET_NAME}`);
  console.error("j9_fetch_capture: set a short-lived HTTPS transfer URL as that Actions secret; never use workflow_dispatch inputs or git commits");
  process.exit(2);
}

const result = await fetchCaptureFromTransferUrl({ url });
if (!result.ok) {
  console.error(`j9_fetch_capture BLOCKED reason=${result.reason}`);
  process.exit(2);
}
console.log(`j9_fetch_capture ok bytes=${result.bytes} path=artifacts/j9/webhook-capture.json`);
