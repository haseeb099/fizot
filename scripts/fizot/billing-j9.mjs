#!/usr/bin/env node
/**
 * J9 Stripe test-mode driver. Credentials alone never exit 0.
 * Requires STRIPE_J9_MODE=test, test API key, webhook secret, and STRIPE_J9_PRICE_HOME.
 */
import { formatJ9Report, runJ9 } from "../../server/fizot/billing/j9-driver.ts";

const report = await runJ9({
  env: process.env,
  log: (line) => console.error(line),
});
console.log(formatJ9Report(report));
process.exit(report.exitCode);
