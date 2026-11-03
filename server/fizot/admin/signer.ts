import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CLOUD_PAIRING_NONCE_MS,
  CLOUD_PAIRING_SKEW_S,
  cloudRequestSignature,
} from "../../cloud-home.ts";
import type { NonceStore } from "./nonce-store.ts";

export const ADMIN_SIGN_SKEW_S = CLOUD_PAIRING_SKEW_S;
export const ADMIN_NONCE_TTL_MS = CLOUD_PAIRING_NONCE_MS;

/** Canonical form from docs/cloud-pro.md contract v1 (same as cloudRequestSignature). */
export function adminRequestSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  method: string,
  target: string,
  body: Buffer | string,
): string {
  return cloudRequestSignature(secret, timestamp, nonce, method, target, body);
}

export function bodyHash(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("base64url");
}

export function mintNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function mintBootstrapSecret(): string {
  return randomBytes(32).toString("base64url");
}

export type SignHeaders = {
  "x-omb-cloud-timestamp": string;
  "x-omb-cloud-nonce": string;
  "x-omb-cloud-signature": string;
};

export async function signAdminRequest(input: {
  secret: string;
  method: string;
  target: string;
  body?: Buffer | string;
  now?: () => number;
  nonces: NonceStore;
}): Promise<SignHeaders> {
  const now = input.now ?? Date.now;
  const at = now();
  const timestamp = String(Math.floor(at / 1000));
  let nonce = mintNonce();
  for (let i = 0; i < 8; i++) {
    if (await input.nonces.reserve(nonce, at + ADMIN_NONCE_TTL_MS, at)) break;
    nonce = mintNonce();
  }
  const body = input.body ?? "";
  const signature = adminRequestSignature(input.secret, timestamp, nonce, input.method, input.target, body);
  return {
    "x-omb-cloud-timestamp": timestamp,
    "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${signature}`,
  };
}

/** Verifier for inbound Admin callbacks (tests / future webhooks). Signature first, then skew, then nonce. */
export async function verifyAdminRequest(input: {
  secret: string;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  method: string;
  target: string;
  body: Buffer | string;
  now?: () => number;
  nonces: NonceStore;
}): Promise<{ ok: true } | { ok: false; error: "invalid_signature" | "stale_request" | "replayed_request" }> {
  const now = input.now ?? Date.now;
  const timestamp = input.timestamp ?? "";
  const nonce = input.nonce ?? "";
  const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(input.signature ?? "")?.[1];
  const expected = Buffer.from(adminRequestSignature(input.secret, timestamp, nonce, input.method, input.target, input.body), "base64url");
  const given = presented ? Buffer.from(presented, "base64url") : Buffer.alloc(expected.length);
  const matches = given.length === expected.length && timingSafeEqual(given, expected);
  if (!presented || !matches || !/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return { ok: false, error: "invalid_signature" };
  }
  const at = now();
  if (Math.abs(at / 1000 - Number(timestamp)) > ADMIN_SIGN_SKEW_S) {
    return { ok: false, error: "stale_request" };
  }
  if (!(await input.nonces.reserve(nonce, at + ADMIN_NONCE_TTL_MS, at))) {
    return { ok: false, error: "replayed_request" };
  }
  return { ok: true };
}
