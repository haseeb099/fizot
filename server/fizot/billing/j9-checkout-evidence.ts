/**
 * Live Checkout evidence checks. Never manufactures a completed Session.
 */
import type { J9RunArtifact } from "./j9-run-artifact.ts";

export type CheckoutEvidenceResult =
  | {
    ok: true;
    sessionId: string;
    customerId: string;
    subscriptionId: string;
    paymentStatus: "paid";
    status: "complete";
  }
  | { ok: false; reason: string; blocked?: boolean };

function requireId(value: unknown, prefix: string): string | null {
  return typeof value === "string" && value.startsWith(prefix) ? value : null;
}

/**
 * Confirm a fetched Checkout Session belongs to this run and is genuinely paid.
 */
export function assertCompletedCheckoutSession(
  session: Record<string, unknown> | null | undefined,
  artifact: J9RunArtifact,
): CheckoutEvidenceResult {
  if (session == null || typeof session !== "object" || Array.isArray(session)) {
    return { ok: false, reason: "checkout_session_missing", blocked: true };
  }
  if (session.object !== "checkout.session") {
    return { ok: false, reason: "not_a_checkout_session" };
  }
  const sessionId = requireId(session.id, "cs_");
  if (!sessionId) return { ok: false, reason: "checkout_session_id_missing" };
  if (sessionId !== artifact.checkout.sessionId) {
    return { ok: false, reason: "checkout_session_foreign_run" };
  }
  if (!Object.prototype.hasOwnProperty.call(session, "livemode")) {
    return { ok: false, reason: "checkout_livemode_missing" };
  }
  if (session.livemode !== false) {
    return { ok: false, reason: session.livemode === true ? "checkout_livemode_true" : "checkout_livemode_invalid" };
  }
  const customerId = requireId(session.customer, "cus_");
  if (!customerId) return { ok: false, reason: "checkout_customer_missing", blocked: true };
  if (customerId !== artifact.checkout.customerId) {
    return { ok: false, reason: "checkout_customer_mismatch" };
  }
  const metadata = session.metadata as Record<string, unknown> | undefined;
  const runMeta = typeof metadata?.fizot_j9_run_id === "string" ? metadata.fizot_j9_run_id : null;
  if (!runMeta) return { ok: false, reason: "checkout_run_metadata_missing" };
  if (runMeta !== artifact.runId) {
    return { ok: false, reason: "checkout_run_metadata_mismatch" };
  }
  if (session.status !== "complete" || session.payment_status !== "paid") {
    return {
      ok: false,
      reason: `checkout_incomplete status=${String(session.status)} payment_status=${String(session.payment_status)}`,
      blocked: true,
    };
  }
  const subscriptionId = requireId(session.subscription, "sub_");
  if (!subscriptionId) {
    return { ok: false, reason: "checkout_subscription_missing", blocked: true };
  }
  return {
    ok: true,
    sessionId,
    customerId,
    subscriptionId,
    paymentStatus: "paid",
    status: "complete",
  };
}

export function assertCustomerBelongsToRun(
  customer: Record<string, unknown> | null | undefined,
  expected: { customerId: string; runId: string },
): { ok: true } | { ok: false; reason: string } {
  if (customer == null || typeof customer !== "object" || Array.isArray(customer)) {
    return { ok: false, reason: "customer_missing" };
  }
  if (customer.object !== "customer") return { ok: false, reason: "not_a_customer" };
  const id = requireId(customer.id, "cus_");
  if (!id || id !== expected.customerId) return { ok: false, reason: "customer_id_mismatch" };
  if (customer.livemode !== false) return { ok: false, reason: "customer_livemode_invalid" };
  const metadata = customer.metadata as Record<string, unknown> | undefined;
  const runMeta = typeof metadata?.fizot_j9_run_id === "string" ? metadata.fizot_j9_run_id : null;
  if (runMeta !== expected.runId) return { ok: false, reason: "customer_run_metadata_mismatch" };
  return { ok: true };
}

export function assertSubscriptionPrice(
  subscription: Record<string, unknown> | null | undefined,
  expected: { subscriptionId: string; customerId: string; priceId: string; runId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (subscription == null || typeof subscription !== "object" || Array.isArray(subscription)) {
    return { ok: false, reason: "subscription_missing" };
  }
  if (subscription.object !== "subscription") return { ok: false, reason: "not_a_subscription" };
  const id = requireId(subscription.id, "sub_");
  if (!id || id !== expected.subscriptionId) return { ok: false, reason: "subscription_id_mismatch" };
  if (subscription.livemode !== false) return { ok: false, reason: "subscription_livemode_invalid" };
  const customerId = requireId(subscription.customer, "cus_");
  if (!customerId || customerId !== expected.customerId) return { ok: false, reason: "subscription_customer_mismatch" };
  const items = subscription.items as { data?: Array<{ price?: { id?: unknown } | string }> } | undefined;
  const priceRaw = items?.data?.[0]?.price;
  const priceId = typeof priceRaw === "string"
    ? priceRaw
    : priceRaw && typeof priceRaw === "object" && typeof priceRaw.id === "string"
      ? priceRaw.id
      : null;
  if (!priceId || priceId !== expected.priceId) {
    return { ok: false, reason: `subscription_price_mismatch got=${String(priceId)}` };
  }
  if (expected.runId) {
    const metadata = subscription.metadata as Record<string, unknown> | undefined;
    const runMeta = typeof metadata?.fizot_j9_run_id === "string" ? metadata.fizot_j9_run_id : null;
    if (runMeta !== expected.runId) return { ok: false, reason: "subscription_run_metadata_mismatch" };
  }
  return { ok: true };
}
