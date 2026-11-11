#!/usr/bin/env node
/**
 * J9 Stripe test-mode driver. Credentials alone never exit 0.
 * Stages: full (default), prepare, resume, cleanup.
 * Artifact and capture paths are fixed under artifacts/j9/ (see j9-config).
 */
import { formatJ9Report, runJ9 } from "../../server/fizot/billing/j9-driver.ts";

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const stage = argValue("stage") ?? process.env.STRIPE_J9_STAGE ?? "full";
const confirm = argValue("confirm") ?? process.env.STRIPE_J9_CLEANUP_CONFIRM ?? "";
const artifactRunId =
  argValue("artifact-run-id")
  ?? process.env.STRIPE_J9_ARTIFACT_RUN_ID
  ?? argValue("prepare-run-id")
  ?? process.env.STRIPE_J9_PREPARE_RUN_ID
  ?? "";

const env = {
  ...process.env,
  STRIPE_J9_STAGE: stage,
  ...(confirm ? { STRIPE_J9_CLEANUP_CONFIRM: confirm } : {}),
  ...(artifactRunId ? { STRIPE_J9_ARTIFACT_RUN_ID: artifactRunId } : {}),
};

const report = await runJ9({
  env,
  log: (line) => console.error(line),
});
console.log(formatJ9Report(report));
if (report.checkoutUrl) {
  console.error(`j9_operator Open this Checkout URL with a Stripe test card, then resume the SAME run:\n${report.checkoutUrl}`);
}
if (report.runId) {
  console.error(`j9_operator runId=${report.runId} (cleanup confirm). For Actions retries use the GitHub run that uploaded the LATEST j9-run-artifact as artifact_run_id.`);
}
process.exit(report.exitCode);
