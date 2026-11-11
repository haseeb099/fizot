#!/usr/bin/env node
/**
 * J9 Stripe test-mode driver. Credentials alone never exit 0.
 * Stages: full (default), prepare, resume, cleanup.
 * Live acceptance requires prepare → manual Checkout → resume with signed webhook capture.
 */
import { formatJ9Report, runJ9 } from "../../server/fizot/billing/j9-driver.ts";

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const stage = argValue("stage") ?? process.env.STRIPE_J9_STAGE ?? "full";
const artifact = argValue("artifact") ?? process.env.STRIPE_J9_ARTIFACT_PATH ?? "";
const capture = argValue("webhook-capture") ?? process.env.STRIPE_J9_WEBHOOK_CAPTURE_PATH ?? "";
const confirm = argValue("confirm") ?? process.env.STRIPE_J9_CLEANUP_CONFIRM ?? "";

const env = {
  ...process.env,
  STRIPE_J9_STAGE: stage,
  ...(artifact ? { STRIPE_J9_ARTIFACT_PATH: artifact } : {}),
  ...(capture ? { STRIPE_J9_WEBHOOK_CAPTURE_PATH: capture } : {}),
  ...(confirm ? { STRIPE_J9_CLEANUP_CONFIRM: confirm } : {}),
};

const report = await runJ9({
  env,
  log: (line) => console.error(line),
});
console.log(formatJ9Report(report));
if (report.checkoutUrl) {
  console.error(`j9_operator Open this Checkout URL in a browser with a Stripe test card, then resume:\n${report.checkoutUrl}`);
}
process.exit(report.exitCode);
