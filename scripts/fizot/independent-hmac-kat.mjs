#!/usr/bin/env node
/**
 * Independent known-answer for the cloud-home Admin request signature.
 * Uses only node:crypto — must not import server/cloud-home.ts or signer.ts.
 * Algorithm (docs/fizot/edge.md / docs/cloud-pro.md):
 *   bodyHash = base64url(SHA-256(rawBody))
 *   canonical = `v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${bodyHash}`
 *   signature = base64url(HMAC-SHA256(secret, canonical))
 */
import { createHash, createHmac } from "node:crypto";

const SECRET = "kat-secret-32-bytes-base64url!!!!";
const TIMESTAMP = "1790000000";
const NONCE = "n".repeat(16);
const METHOD = "POST";
const TARGET = "/api/cloud/pairing";
const BODY = '{"label":"Fizot app (Cloud)","ttlSeconds":300}';

function bodyHash(body) {
  return createHash("sha256").update(body).digest("base64url");
}

function independentSignature(secret, timestamp, nonce, method, target, body) {
  const hash = bodyHash(body);
  const canonical = `v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${hash}`;
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

const signature = independentSignature(SECRET, TIMESTAMP, NONCE, METHOD, TARGET, BODY);
const payload = {
  secret: SECRET,
  timestamp: TIMESTAMP,
  nonce: NONCE,
  method: METHOD,
  target: TARGET,
  body: BODY,
  bodyHash: bodyHash(BODY),
  signature,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else {
  process.stdout.write(`${signature}\n`);
}
