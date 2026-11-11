/**
 * Optional Stripe CLI / local capture of signed webhook deliveries.
 * Local fixtures prove signature unit behaviour; live acceptance needs
 * Stripe-originated signed bodies without exposing a public endpoint.
 */
import { readFileSync } from "node:fs";
import { verifyStripeSignature } from "../admin/webhooks.ts";

export const J9_WEBHOOK_CAPTURE_SCHEMA = 1 as const;

export type J9WebhookDelivery = {
  body: string;
  stripeSignatureHeader: string;
  /** Optional operator note; never required for verification. */
  note?: string;
};

export type J9WebhookCapture = {
  schemaVersion: typeof J9_WEBHOOK_CAPTURE_SCHEMA;
  kind: "stripe_cli_signed_capture";
  runId: string;
  deliveries: J9WebhookDelivery[];
};

export type WebhookCaptureResult =
  | {
    ok: true;
    capture: J9WebhookCapture;
    accepted: Array<{ eventId: string; type: string }>;
  }
  | { ok: false; reason: string };

function parseCapture(raw: unknown): { ok: true; capture: J9WebhookCapture } | { ok: false; reason: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "capture_not_object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== J9_WEBHOOK_CAPTURE_SCHEMA) {
    return { ok: false, reason: "capture_schema_mismatch" };
  }
  if (obj.kind !== "stripe_cli_signed_capture") {
    return { ok: false, reason: "capture_kind_invalid" };
  }
  if (typeof obj.runId !== "string" || !obj.runId.startsWith("j9run_")) {
    return { ok: false, reason: "capture_run_id_invalid" };
  }
  if (!Array.isArray(obj.deliveries) || obj.deliveries.length === 0) {
    return { ok: false, reason: "capture_deliveries_empty" };
  }
  const deliveries: J9WebhookDelivery[] = [];
  for (const row of obj.deliveries) {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, reason: "capture_delivery_invalid" };
    }
    const delivery = row as Record<string, unknown>;
    if (typeof delivery.body !== "string" || !delivery.body) {
      return { ok: false, reason: "capture_body_missing" };
    }
    if (typeof delivery.stripeSignatureHeader !== "string" || !delivery.stripeSignatureHeader.includes("v1=")) {
      return { ok: false, reason: "capture_signature_header_invalid" };
    }
    if (delivery.body.includes("sk_test_") || delivery.body.includes("sk_live_") || delivery.body.includes("whsec_")) {
      return { ok: false, reason: "capture_body_contains_secret_material" };
    }
    deliveries.push({
      body: delivery.body,
      stripeSignatureHeader: delivery.stripeSignatureHeader,
      note: typeof delivery.note === "string" ? delivery.note : undefined,
    });
  }
  return {
    ok: true,
    capture: {
      schemaVersion: J9_WEBHOOK_CAPTURE_SCHEMA,
      kind: "stripe_cli_signed_capture",
      runId: obj.runId,
      deliveries,
    },
  };
}

export function loadWebhookCapture(path: string): { ok: true; capture: J9WebhookCapture } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "capture_unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "capture_json_invalid" };
  }
  return parseCapture(parsed);
}

/**
 * Verify captured Stripe-signed deliveries. Wrong signatures fail. Duplicate
 * event ids are tolerated as idempotent evidence once at least one accept exists.
 */
export function verifyWebhookCapture(input: {
  capture: J9WebhookCapture;
  expectedRunId: string;
  webhookSecret: string;
  nowMs?: number;
}): WebhookCaptureResult {
  if (input.capture.runId !== input.expectedRunId) {
    return { ok: false, reason: "capture_run_id_mismatch" };
  }
  const accepted: Array<{ eventId: string; type: string }> = [];
  const seen = new Set<string>();
  for (const delivery of input.capture.deliveries) {
    let eventCreated = Math.floor((input.nowMs ?? Date.now()) / 1000);
    try {
      const parsed = JSON.parse(delivery.body) as { created?: unknown; id?: unknown; type?: unknown };
      if (typeof parsed.created === "number") eventCreated = parsed.created;
      const verified = verifyStripeSignature({
        secret: input.webhookSecret,
        body: delivery.body,
        header: delivery.stripeSignatureHeader,
        now: () => eventCreated * 1000 + 1000,
      });
      if (!verified.ok) {
        return { ok: false, reason: `capture_signature_${verified.error}` };
      }
      if (typeof parsed.id !== "string" || !parsed.id.startsWith("evt_")) {
        return { ok: false, reason: "capture_event_id_invalid" };
      }
      if (typeof parsed.type !== "string" || !parsed.type) {
        return { ok: false, reason: "capture_event_type_invalid" };
      }
      if (seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      accepted.push({ eventId: parsed.id, type: parsed.type });
    } catch {
      return { ok: false, reason: "capture_body_not_json_event" };
    }
  }
  if (accepted.length === 0) {
    return { ok: false, reason: "capture_no_accepted_events" };
  }
  return { ok: true, capture: input.capture, accepted };
}
