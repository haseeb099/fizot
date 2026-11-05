#!/usr/bin/env node
/**
 * Independent known-answer vectors for Admin webhook signatures.
 * Uses only node:crypto — must not import server/fizot/admin/webhooks.ts.
 *
 * Generic: HMAC-SHA256 hex of `${timestamp}.${body}`
 * Stripe:  header `t=${t},v1=${HMAC-SHA256 hex of `${t}.${body}`}`
 */
import { createHmac } from "node:crypto";

const GENERIC_SECRET = "kat-webhook-generic-secret-32b!!!!";
const STRIPE_SECRET = "kat-webhook-stripe-secret-32bytes!";
const TIMESTAMP = "1790000000";
const BODY = '{"id":"evt_kat_1","type":"test.event","data":{"object":{"id":"obj_1"}}}';

function genericSignature(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function stripeHeader(secret, timestamp, body) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const payload = {
  generic: {
    secret: GENERIC_SECRET,
    body: BODY,
    timestamp: TIMESTAMP,
    signature: genericSignature(GENERIC_SECRET, TIMESTAMP, BODY),
  },
  stripe: {
    secret: STRIPE_SECRET,
    body: BODY,
    timestamp: TIMESTAMP,
    header: stripeHeader(STRIPE_SECRET, TIMESTAMP, BODY),
  },
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else {
  process.stdout.write(`generic=${payload.generic.signature}\nstripe=${payload.stripe.header}\n`);
}
