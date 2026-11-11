/**
 * Stripe CLI signed webhook capture. Signature freshness uses the Stripe-Signature
 * header `t=` value, never the untrusted event body `created` field.
 * Capture `provenance` is an operator claim only — never live acceptance by itself.
 */
import { readFileSync } from "node:fs";
import { verifyStripeSignature } from "../admin/webhooks.ts";
import type { J9StripeTransport } from "./j9-transport.ts";

export const J9_WEBHOOK_CAPTURE_SCHEMA = 2 as const;

/** Minimum event types required for live webhook lifecycle coverage of a Checkout run. */
export const J9_REQUIRED_CAPTURE_TYPES = [
  "checkout.session.completed",
  "invoice.paid",
] as const;

export type J9WebhookDelivery = {
  body: string;
  stripeSignatureHeader: string;
  /** Operator claim only — not independently verified provenance. */
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
  customerId: string;
  subscriptionId: string | null;
  sessionId: string | null;
  deliveryTimestampSec: number;
  provenanceClaim: J9WebhookDelivery["provenance"];
  signatureVerified: true;
  stripeOriginVerified: boolean;
};

export type WebhookCaptureChecks = {
  signatureVerified: boolean;
  stripeOriginVerified: boolean;
  ownershipVerified: boolean;
  journeyLinked: boolean;
  provenanceIsOperatorClaimOnly: true;
};

export type WebhookCaptureResult =
  | {
    ok: true;
    capture: J9WebhookCapture;
    accepted: AcceptedCaptureEvent[];
    coverage: string[];
    checks: WebhookCaptureChecks;
  }
  | {
    ok: false;
    reason: string;
    blocked?: boolean;
    checks: WebhookCaptureChecks;
  };

function emptyChecks(partial: Partial<WebhookCaptureChecks> = {}): WebhookCaptureChecks {
  return {
    signatureVerified: false,
    stripeOriginVerified: false,
    ownershipVerified: false,
    journeyLinked: false,
    provenanceIsOperatorClaimOnly: true,
    ...partial,
  };
}

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

function objectIds(obj: Record<string, unknown>): {
  customerId: string | null;
  subscriptionId: string | null;
  sessionId: string | null;
  runId: string | null;
} {
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
  const sessionId = typeof obj.id === "string" && obj.object === "checkout.session" && obj.id.startsWith("cs_")
    ? obj.id
    : typeof obj.checkout_session === "string" && obj.checkout_session.startsWith("cs_")
      ? obj.checkout_session
      : null;
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const runId = typeof metadata?.fizot_j9_run_id === "string" ? metadata.fizot_j9_run_id : null;
  return { customerId, subscriptionId, sessionId, runId };
}

type ParsedDelivery = {
  eventId: string;
  type: string;
  body: string;
  deliveryTs: number;
  provenance: J9WebhookDelivery["provenance"];
  customerId: string;
  subscriptionId: string | null;
  sessionId: string | null;
  runId: string;
  dataObject: Record<string, unknown>;
};

/**
 * Cryptographic signature verification only. Does not establish Stripe-origin
 * business state or live acceptance.
 */
export function verifyWebhookCaptureSignatures(input: {
  capture: J9WebhookCapture;
  expectedRunId: string;
  expectedCustomerId: string;
  expectedSubscriptionId: string;
  expectedSessionId: string;
  webhookSecret: string;
  nowMs?: number;
  historicalMaxSkewSec?: number;
}): { ok: true; accepted: ParsedDelivery[]; checks: WebhookCaptureChecks } | { ok: false; reason: string; checks: WebhookCaptureChecks } {
  if (input.capture.runId !== input.expectedRunId) {
    return { ok: false, reason: "capture_run_id_mismatch", checks: emptyChecks() };
  }
  const nowMs = input.nowMs ?? Date.now();
  const accepted: ParsedDelivery[] = [];
  const seen = new Set<string>();
  for (const delivery of input.capture.deliveries) {
    const deliveryTs = parseHeaderTimestamp(delivery.stripeSignatureHeader);
    if (deliveryTs == null) {
      return { ok: false, reason: "capture_header_timestamp_missing", checks: emptyChecks() };
    }
    const isHistorical = delivery.provenance === "historical_export";
    const maxSkewSec = isHistorical ? (input.historicalMaxSkewSec ?? 7 * 24 * 3600) : 300;
    const verified = verifyStripeSignature({
      secret: input.webhookSecret,
      body: delivery.body,
      header: delivery.stripeSignatureHeader,
      now: () => nowMs,
      maxSkewSec,
    });
    if (!verified.ok) {
      return { ok: false, reason: `capture_signature_${verified.error}`, checks: emptyChecks() };
    }
    if (Number(verified.timestamp) !== deliveryTs) {
      return { ok: false, reason: "capture_header_timestamp_mismatch", checks: emptyChecks({ signatureVerified: false }) };
    }
    let parsed: {
      id?: unknown;
      type?: unknown;
      data?: { object?: unknown };
    };
    try {
      parsed = JSON.parse(delivery.body) as typeof parsed;
    } catch {
      return { ok: false, reason: "capture_body_not_json_event", checks: emptyChecks() };
    }
    if (typeof parsed.id !== "string" || !parsed.id.startsWith("evt_")) {
      return { ok: false, reason: "capture_event_id_invalid", checks: emptyChecks() };
    }
    if (typeof parsed.type !== "string" || !parsed.type) {
      return { ok: false, reason: "capture_event_type_invalid", checks: emptyChecks() };
    }
    const dataObj = parsed.data?.object;
    if (!dataObj || typeof dataObj !== "object" || Array.isArray(dataObj)) {
      return { ok: false, reason: "capture_event_object_missing", checks: emptyChecks() };
    }
    const ids = objectIds(dataObj as Record<string, unknown>);
    // Explicit ownership: missing run metadata is not verified ownership.
    if (!ids.runId) {
      return {
        ok: false,
        reason: "capture_event_run_metadata_missing",
        checks: emptyChecks({ signatureVerified: true }),
      };
    }
    if (ids.runId !== input.expectedRunId) {
      return {
        ok: false,
        reason: "capture_event_run_mismatch",
        checks: emptyChecks({ signatureVerified: true }),
      };
    }
    if (!ids.customerId) {
      return {
        ok: false,
        reason: "capture_event_customer_missing",
        checks: emptyChecks({ signatureVerified: true }),
      };
    }
    if (ids.customerId !== input.expectedCustomerId) {
      return {
        ok: false,
        reason: "capture_event_customer_mismatch",
        checks: emptyChecks({ signatureVerified: true }),
      };
    }
    if (parsed.type === "checkout.session.completed") {
      if (!ids.sessionId || ids.sessionId !== input.expectedSessionId) {
        return {
          ok: false,
          reason: "capture_session_mismatch",
          checks: emptyChecks({ signatureVerified: true }),
        };
      }
      if (!ids.subscriptionId || ids.subscriptionId !== input.expectedSubscriptionId) {
        return {
          ok: false,
          reason: "capture_session_subscription_mismatch",
          checks: emptyChecks({ signatureVerified: true }),
        };
      }
    }
    if (parsed.type === "invoice.paid") {
      if (!ids.subscriptionId) {
        return {
          ok: false,
          reason: "capture_required_event_subscription_missing",
          checks: emptyChecks({ signatureVerified: true }),
        };
      }
      if (ids.subscriptionId !== input.expectedSubscriptionId) {
        return {
          ok: false,
          reason: "capture_event_subscription_mismatch",
          checks: emptyChecks({ signatureVerified: true }),
        };
      }
    } else if (ids.subscriptionId && ids.subscriptionId !== input.expectedSubscriptionId) {
      return {
        ok: false,
        reason: "capture_event_subscription_mismatch",
        checks: emptyChecks({ signatureVerified: true }),
      };
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    accepted.push({
      eventId: parsed.id,
      type: parsed.type,
      body: delivery.body,
      deliveryTs,
      provenance: delivery.provenance,
      customerId: ids.customerId,
      subscriptionId: ids.subscriptionId,
      sessionId: ids.sessionId,
      runId: ids.runId,
      dataObject: dataObj as Record<string, unknown>,
    });
  }
  if (accepted.length === 0) {
    return { ok: false, reason: "capture_no_accepted_events", checks: emptyChecks({ signatureVerified: true }) };
  }
  const present = new Set(accepted.map((row) => row.type));
  const missing = J9_REQUIRED_CAPTURE_TYPES.filter((type) => !present.has(type));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `capture_missing_required_types:${missing.join(",")}`,
      checks: emptyChecks({ signatureVerified: true, ownershipVerified: true }),
    };
  }
  const sessionEvt = accepted.find((row) => row.type === "checkout.session.completed");
  const paidEvt = accepted.find((row) => row.type === "invoice.paid");
  if (!sessionEvt || !paidEvt) {
    return {
      ok: false,
      reason: "capture_required_pair_missing",
      checks: emptyChecks({ signatureVerified: true, ownershipVerified: true }),
    };
  }
  if (sessionEvt.subscriptionId !== paidEvt.subscriptionId || sessionEvt.customerId !== paidEvt.customerId) {
    return {
      ok: false,
      reason: "capture_checkout_invoice_journey_mismatch",
      checks: emptyChecks({ signatureVerified: true, ownershipVerified: true }),
    };
  }
  return {
    ok: true,
    accepted,
    checks: emptyChecks({
      signatureVerified: true,
      ownershipVerified: true,
      journeyLinked: true,
    }),
  };
}

/**
 * Full live capture verification: signatures + authenticated Stripe Event retrieval.
 * Provenance labels remain operator claims and never alone establish acceptance.
 */
export async function verifyWebhookCapture(input: {
  capture: J9WebhookCapture;
  expectedRunId: string;
  expectedCustomerId: string;
  expectedSubscriptionId: string;
  expectedSessionId: string;
  webhookSecret: string;
  transport: J9StripeTransport;
  nowMs?: number;
  historicalMaxSkewSec?: number;
}): Promise<WebhookCaptureResult> {
  const signed = verifyWebhookCaptureSignatures(input);
  if (!signed.ok) {
    return { ok: false, reason: signed.reason, checks: signed.checks };
  }

  const accepted: AcceptedCaptureEvent[] = [];
  for (const row of signed.accepted) {
    let remote: Record<string, unknown>;
    try {
      remote = await input.transport.request("GET", `events/${row.eventId}`, null);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 80) : "event_retrieve_failed";
      return {
        ok: false,
        reason: `capture_stripe_origin_unverified:${detail}`,
        blocked: true,
        checks: {
          ...signed.checks,
          stripeOriginVerified: false,
        },
      };
    }
    if (remote.object !== "event" || remote.id !== row.eventId) {
      return {
        ok: false,
        reason: "capture_stripe_event_id_mismatch",
        blocked: true,
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    if (remote.livemode !== false) {
      return {
        ok: false,
        reason: "capture_stripe_event_livemode_invalid",
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    if (remote.type !== row.type) {
      return {
        ok: false,
        reason: "capture_stripe_event_type_mismatch",
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    const remoteObj = (remote.data as { object?: unknown } | undefined)?.object;
    if (!remoteObj || typeof remoteObj !== "object" || Array.isArray(remoteObj)) {
      return {
        ok: false,
        reason: "capture_stripe_event_object_missing",
        blocked: true,
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    const remoteIds = objectIds(remoteObj as Record<string, unknown>);
    if (remoteIds.runId !== input.expectedRunId) {
      return {
        ok: false,
        reason: "capture_stripe_event_run_mismatch",
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    if (remoteIds.customerId !== input.expectedCustomerId) {
      return {
        ok: false,
        reason: "capture_stripe_event_customer_mismatch",
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    if (row.type === "checkout.session.completed" && remoteIds.sessionId !== input.expectedSessionId) {
      return {
        ok: false,
        reason: "capture_stripe_event_session_mismatch",
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    if (row.type === "invoice.paid" && remoteIds.subscriptionId !== input.expectedSubscriptionId) {
      return {
        ok: false,
        reason: "capture_stripe_event_subscription_mismatch",
        checks: { ...signed.checks, stripeOriginVerified: false },
      };
    }
    accepted.push({
      eventId: row.eventId,
      type: row.type,
      customerId: row.customerId,
      subscriptionId: row.subscriptionId,
      sessionId: row.sessionId,
      deliveryTimestampSec: row.deliveryTs,
      provenanceClaim: row.provenance,
      signatureVerified: true,
      stripeOriginVerified: true,
    });
  }

  return {
    ok: true,
    capture: input.capture,
    accepted,
    coverage: [...J9_REQUIRED_CAPTURE_TYPES],
    checks: {
      signatureVerified: true,
      stripeOriginVerified: true,
      ownershipVerified: true,
      journeyLinked: true,
      provenanceIsOperatorClaimOnly: true,
    },
  };
}
