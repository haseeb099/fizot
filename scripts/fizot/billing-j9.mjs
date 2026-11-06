#!/usr/bin/env node
/**
 * J9 Stripe test-mode driver. Refuses to run when the repo secrets are absent.
 * Manual workflow only. Does not invent a subscription.
 */
const key = process.env.STRIPE_TEST_API_KEY?.trim() ?? "";
const secret = process.env.STRIPE_TEST_WEBHOOK_SECRET?.trim() ?? "";
const missing = [
  ...(key ? [] : ["STRIPE_TEST_API_KEY"]),
  ...(secret ? [] : ["STRIPE_TEST_WEBHOOK_SECRET"]),
];
if (missing.length > 0) {
  console.error(`missing_secret ${missing.join(" ")}`);
  process.exit(2);
}
console.error("stripe_test_secrets_present");
process.exit(0);
