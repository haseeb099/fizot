/**
 * Stripe CLI signed webhook capture. Signature freshness uses the Stripe-Signature
 * header `t=` value, never the untrusted event body `created` field.
 */
import { readFileSync } from "node:fs";
import { verifyStripeSignature } from "../admin/webhooks.ts";

export const J9_WEBHOOK_CAPTURE_SCHEMA = 2 as const;

/** Minimum event types required for live webhook lifecycle coverage of a Checkout run. */
export const J9_REQUIRED_CAPTURE_TYPES = [
  "checkout.session.completed",
  "invoice.paid",
] as const;

export type J9WebhookDelivery = {
  body: string;
  stripeSignatureHeader: string;
  /** Operator provenance: how the capture was obtained. */
  provenance: "stripe_cli_listen" | "stripe_cli_trigger_forward" | "historical_export";
  note?: string;
};

export type J9WebhookCapture = {
  schemaVersion: typeof J9_WEBHOOK_CAPTURE_SCHEMA;
  kind: "stripe_cli_signed_capture";
  runId: string;
  capturedAt: string;
  deliveries: J9WebhookDelivery[];
};

export type AcceptedCaptureEvent = {
  eventId: string;
  type: string;
  customerId: string | null;
  subscriptionId: string | null;
  deliveryTimestampSec: number;
  provenance: J9WebhookDelivery["provenance"];
};

export type WebhookCaptureResult =
  | { ok: true; capture: J9WebhookCapture; accepted: AcceptedCaptureEvent[]; coverage: string[] }
  | { ok: false; reason: string };

function parseHeaderTimestamp(header: string): number | null {
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "t") {
      const ts = Number(rest.join("="));
      return Number.isFinite(ts) ? ts : null;
    }
  }
  return null;
}

function parseCapture(raw: unknown): { ok: true; capture: J9WebhookCapture } | { ok: false; reason: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "capture_not_object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== J9_WEBHOOK_CAPTURE_SCHEMA) {
    return { ok: false, reason: "capture_schema_mismatch" };
  }
  if (obj.kind !== "stripe_cli_signed_capture") return { ok: false, reason: "capture_kind_invalid" };
  if (typeof obj.runId !== "string" || !obj.runId.startsWith("j9run_")) {
    return { ok: false, reason: "capture_run_id_invalid" };
  }
  if (typeof obj.capturedAt !== "string" || !Number.isFinite(Date.parse(obj.capturedAt))) {
    return { ok: false, reason: "capture_captured_at_invalid" };
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
    if (
      delivery.provenance !== "stripe_cli_listen"
      && delivery.provenance !== "stripe_cli_trigger_forward"
      && delivery.provenance !== "historical_export"
    ) {
      return { ok: false, reason: "capture_provenance_invalid" };
    }
    if (delivery.body.includes("sk_test_") || delivery.body.includes("sk_live_") || delivery.body.includes("whsec_")) {
      return { ok: false, reason: "capture_body_contains_secret_material" };
    }
    deliveries.push({
      body: delivery.body,
      stripeSignatureHeader: delivery.stripeSignatureHeader,
      provenance: delivery.provenance,
      note: typeof delivery.note === "string" ? delivery.note : undefined,
    });
  }
  return {
    ok: true,
    capture: {
      schemaVersion: J9_WEBHOOK_CAPTURE_SCHEMA,
      kind: "stripe_cli_signed_capture",
      runId: obj.runId,
      capturedAt: obj.capturedAt,
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

function objectIds(obj: Record<string, unknown>): { customerId: string | null; subscriptionId: string | null; runId: string | null } {
  const customerId = typeof obj.customer === "string" && obj.customer.startsWith("cus_")
    ? obj.customer
    : typeof obj.id === "string" && obj.object === "customer" && obj.id.startsWith("cus_")
      ? obj.id
      : null;
  const subscriptionId = typeof obj.subscription === "string" && obj.subscription.startsWith("sub_")
    ? obj.subscription
    : typeof obj.id === "string" && obj.object === "subscription" && obj.id.startsWith("sub_")
      ? obj.id
      : null;
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const runId = typeof metadata?.fizot_j9_run_id === "string" ? metadata.fizot_j9_run_id : null;
  return { customerId, subscriptionId, runId };
}

/**
 * Verify signed captures. Historical captures use header `t=` with an explicit
 * widened skew and are labelled historical — they never pretend to be a fresh delivery.
 */
export function verifyWebhookCapture(input: {
  capture: J9WebhookCapture;
  expectedRunId: string;
  expectedCustomerId: string;
  expectedSubscriptionId: string;
  webhookSecret: string;
  nowMs?: number;
  /** Widened skew for historical Stripe CLI exports (seconds). Fresh listen uses default 300. */
  historicalMaxSkewSec?: number;
}): WebhookCaptureResult {
  if (input.capture.runId !== input.expectedRunId) {
    return { ok: false, reason: "capture_run_id_mismatch" };
  }
  const nowMs = input.nowMs ?? Date.now();
  const accepted: AcceptedCaptureEvent[] = [];
  const seen = new Set<string>();
  for (const delivery of input.capture.deliveries) {
    const deliveryTs = parseHeaderTimestamp(delivery.stripeSignatureHeader);
    if (deliveryTs == null) return { ok: false, reason: "capture_header_timestamp_missing" };
    const isHistorical = delivery.provenance === "historical_export";
    const maxSkewSec = isHistorical ? (input.historicalMaxSkewSec ?? 7 * 24 * 3600) : 300;
    const verified = verifyStripeSignature({
      secret: input.webhookSecret,
      body: delivery.body,
      header: delivery.stripeSignatureHeader,
      now: () => nowMs,
      maxSkewSec,
    });
    // Re-verify using header t as the authenticity anchor: compare body MAC with t from header.
    // verifyStripeSignature already uses header t for the signed payload and skew against now.
    if (!verified.ok) {
      return { ok: false, reason: `capture_signature_${verified.error}` };
    }
    if (Number(verified.timestamp) !== deliveryTs) {
      return { ok: false, reason: "capture_header_timestamp_mismatch" };
    }
    let parsed: {
      id?: unknown;
      type?: unknown;
      created?: unknown;
      data?: { object?: unknown };
    };
    try {
      parsed = JSON.parse(delivery.body) as typeof parsed;
    } catch {
      return { ok: false, reason: "capture_body_not_json_event" };
    }
    if (typeof parsed.id !== "string" || !parsed.id.startsWith("evt_")) {
      return { ok: false, reason: "capture_event_id_invalid" };
    }
    if (typeof parsed.type !== "string" || !parsed.type) {
      return { ok: false, reason: "capture_event_type_invalid" };
    }
    const dataObj = parsed.data?.object;
    if (!dataObj || typeof dataObj !== "object" || Array.isArray(dataObj)) {
      return { ok: false, reason: "capture_event_object_missing" };
    }
    const ids = objectIds(dataObj as Record<string, unknown>);
    if (ids.runId && ids.runId !== input.expectedRunId) {
      return { ok: false, reason: "capture_event_run_mismatch" };
    }
    if (ids.customerId && ids.customerId !== input.expectedCustomerId) {
      return { ok: false, reason: "capture_event_customer_mismatch" };
    }
    if (ids.subscriptionId && ids.subscriptionId !== input.expectedSubscriptionId) {
      return { ok: false, reason: "capture_event_subscription_mismatch" };
    }
    // Required Checkout/invoice events must carry the expected association.
    if (parsed.type === "checkout.session.completed" || parsed.type === "invoice.paid") {
      if (!ids.customerId) return { ok: false, reason: "capture_required_event_customer_missing" };
      if (parsed.type === "invoice.paid" && !ids.subscriptionId) {
        return { ok: false, reason: "capture_required_event_subscription_missing" };
      }
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    accepted.push({
      eventId: parsed.id,
      type: parsed.type,
      customerId: ids.customerId,
      subscriptionId: ids.subscriptionId,
      deliveryTimestampSec: deliveryTs,
      provenance: delivery.provenance,
    });
  }
  if (accepted.length === 0) return { ok: false, reason: "capture_no_accepted_events" };
  const present = new Set(accepted.map((row) => row.type));
  const missing = J9_REQUIRED_CAPTURE_TYPES.filter((type) => !present.has(type));
  if (missing.length > 0) {
    return { ok: false, reason: `capture_missing_required_types:${missing.join(",")}` };
  }
  return {
    ok: true,
    capture: input.capture,
    accepted,
    coverage: [...J9_REQUIRED_CAPTURE_TYPES],
  };
}
