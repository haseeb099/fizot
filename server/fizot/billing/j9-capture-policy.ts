/**
 * J9 staged-capture timing policy. Distinct from production webhook skew (300s).
 * Capture verification still requires Stripe HMAC + Events API + Session/Subscription ownership.
 */
import { J9_ARTIFACT_MAX_AGE_MS } from "./j9-run-artifact.ts";

/** Maximum age of Stripe-Signature `t=` for J9 capture files (matches run artifact TTL). */
export const J9_CAPTURE_MAX_AGE_SEC = Math.floor(J9_ARTIFACT_MAX_AGE_MS / 1000);

/** Allow small forward clock skew; larger future `t=` values are rejected. */
export const J9_CAPTURE_FUTURE_SKEW_SEC = 60;

export const J9_WEBHOOK_CAPTURE_ARTIFACT_NAME = "j9-webhook-capture";
export const J9_WEBHOOK_CAPTURE_RELATIVE = "artifacts/j9/webhook-capture.json";
export const J9_CAPTURE_INBOX_RELATIVE = "artifacts/j9/inbox";

export type CaptureTimestampCheck =
  | { ok: true; ageSec: number }
  | { ok: false; reason: "capture_timestamp_in_future" | "capture_signature_expired" };

/**
 * Bound staged-capture signature timestamps. Does not replace HMAC verification.
 */
export function checkCaptureSignatureTimestamp(input: {
  timestampSec: number;
  nowMs: number;
  maxAgeSec?: number;
  futureSkewSec?: number;
}): CaptureTimestampCheck {
  const maxAgeSec = input.maxAgeSec ?? J9_CAPTURE_MAX_AGE_SEC;
  const futureSkewSec = input.futureSkewSec ?? J9_CAPTURE_FUTURE_SKEW_SEC;
  const nowSec = Math.floor(input.nowMs / 1000);
  const ageSec = nowSec - input.timestampSec;
  if (ageSec < -futureSkewSec) return { ok: false, reason: "capture_timestamp_in_future" };
  if (ageSec > maxAgeSec) return { ok: false, reason: "capture_signature_expired" };
  return { ok: true, ageSec };
}

export function assertHttpsTransferUrl(url: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "capture_transfer_url_missing" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "capture_transfer_url_invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "capture_transfer_url_must_be_https" };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "capture_transfer_url_must_not_embed_credentials" };
  }
  return { ok: true };
}

export function captureBodyLooksSensitive(body: string): boolean {
  if (body.includes("sk_test_") || body.includes("sk_live_") || body.includes("whsec_")) return true;
  // Stripe test PANs / raw card fields must never appear in capture files.
  const compact = body.replace(/\s+/g, "");
  return compact.includes("4242424242424242")
    || compact.includes("4000000000000002")
    || /"number"\s*:\s*"\d{12,19}"/.test(body);
}
