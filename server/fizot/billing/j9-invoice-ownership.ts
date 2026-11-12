/**
 * Fail-closed Checkout invoice ownership for J9 webhook capture.
 * Invoice metadata is not required; Session + Subscription metadata are authoritative.
 */
import type { J9StripeTransport } from "./j9-transport.ts";

export function runIdFromMetadata(obj: Record<string, unknown>): string | null {
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  return typeof metadata?.fizot_j9_run_id === "string" ? metadata.fizot_j9_run_id : null;
}

/**
 * Resolve the subscription id from a Stripe Invoice object.
 * Supports legacy `subscription` and modern `parent.subscription_details.subscription`
 * (API versions that expose invoice parent details).
 */
export function subscriptionIdFromInvoiceObject(obj: Record<string, unknown>): string | null {
  if (typeof obj.subscription === "string" && obj.subscription.startsWith("sub_")) {
    return obj.subscription;
  }
  const parent = obj.parent as Record<string, unknown> | null | undefined;
  if (parent && typeof parent === "object" && !Array.isArray(parent)) {
    const details = parent.subscription_details as Record<string, unknown> | null | undefined;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const sub = details.subscription;
      if (typeof sub === "string" && sub.startsWith("sub_")) return sub;
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        const expanded = sub as Record<string, unknown>;
        if (typeof expanded.id === "string" && expanded.id.startsWith("sub_")) return expanded.id;
      }
    }
  }
  return null;
}

export function customerIdFromObject(obj: Record<string, unknown>): string | null {
  if (typeof obj.customer === "string" && obj.customer.startsWith("cus_")) return obj.customer;
  if (typeof obj.id === "string" && obj.object === "customer" && obj.id.startsWith("cus_")) return obj.id;
  return null;
}

export type InvoiceOwnershipProof = {
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  sessionId: string;
  runId: string;
};

/**
 * Prove an invoice belongs to the artifact Checkout Session/Subscription.
 * Rejects customer-only matches and missing Session/Subscription run metadata.
 */
export async function proveInvoiceCheckoutOwnership(input: {
  transport: J9StripeTransport;
  invoiceObject: Record<string, unknown>;
  expectedRunId: string;
  expectedCustomerId: string;
  expectedSubscriptionId: string;
  expectedSessionId: string;
}): Promise<{ ok: true; proof: InvoiceOwnershipProof } | { ok: false; reason: string }> {
  const invoiceId = typeof input.invoiceObject.id === "string" && input.invoiceObject.id.startsWith("in_")
    ? input.invoiceObject.id
    : null;
  if (!invoiceId) return { ok: false, reason: "capture_invoice_id_invalid" };

  const eventCustomer = customerIdFromObject(input.invoiceObject);
  if (!eventCustomer) return { ok: false, reason: "capture_invoice_customer_missing" };
  if (eventCustomer !== input.expectedCustomerId) {
    return { ok: false, reason: "capture_invoice_customer_mismatch" };
  }

  let subscriptionId = subscriptionIdFromInvoiceObject(input.invoiceObject);
  let invoiceLive: Record<string, unknown> = input.invoiceObject;
  try {
    invoiceLive = await input.transport.request("GET", `invoices/${invoiceId}`, null);
  } catch {
    return { ok: false, reason: "capture_invoice_retrieve_failed" };
  }
  if (invoiceLive.object !== "invoice" || invoiceLive.id !== invoiceId) {
    return { ok: false, reason: "capture_invoice_retrieve_mismatch" };
  }
  if (invoiceLive.livemode !== false && invoiceLive.livemode != null) {
    return { ok: false, reason: "capture_invoice_livemode_invalid" };
  }
  const liveCustomer = customerIdFromObject(invoiceLive);
  if (!liveCustomer || liveCustomer !== input.expectedCustomerId) {
    return { ok: false, reason: "capture_invoice_live_customer_mismatch" };
  }
  subscriptionId = subscriptionIdFromInvoiceObject(invoiceLive) ?? subscriptionId;
  if (!subscriptionId) return { ok: false, reason: "capture_invoice_subscription_unresolved" };
  if (subscriptionId !== input.expectedSubscriptionId) {
    return { ok: false, reason: "capture_invoice_subscription_mismatch" };
  }

  let subscription: Record<string, unknown>;
  try {
    subscription = await input.transport.request("GET", `subscriptions/${subscriptionId}`, null);
  } catch {
    return { ok: false, reason: "capture_subscription_retrieve_failed" };
  }
  if (subscription.object !== "subscription" || subscription.id !== subscriptionId) {
    return { ok: false, reason: "capture_subscription_retrieve_mismatch" };
  }
  const subCustomer = customerIdFromObject(subscription);
  if (!subCustomer || subCustomer !== input.expectedCustomerId) {
    return { ok: false, reason: "capture_subscription_customer_mismatch" };
  }
  const subRunId = runIdFromMetadata(subscription);
  if (!subRunId) return { ok: false, reason: "capture_subscription_run_metadata_missing" };
  if (subRunId !== input.expectedRunId) {
    return { ok: false, reason: "capture_subscription_run_mismatch" };
  }

  let session: Record<string, unknown>;
  try {
    session = await input.transport.request("GET", `checkout/sessions/${input.expectedSessionId}`, null);
  } catch {
    return { ok: false, reason: "capture_session_retrieve_failed" };
  }
  if (session.object !== "checkout.session" || session.id !== input.expectedSessionId) {
    return { ok: false, reason: "capture_session_retrieve_mismatch" };
  }
  const sessionCustomer = customerIdFromObject(session);
  if (!sessionCustomer || sessionCustomer !== input.expectedCustomerId) {
    return { ok: false, reason: "capture_session_customer_mismatch" };
  }
  const sessionSub = typeof session.subscription === "string" ? session.subscription : null;
  if (!sessionSub || sessionSub !== input.expectedSubscriptionId) {
    return { ok: false, reason: "capture_session_subscription_mismatch" };
  }
  const sessionRunId = runIdFromMetadata(session);
  if (!sessionRunId) return { ok: false, reason: "capture_session_run_metadata_missing" };
  if (sessionRunId !== input.expectedRunId) {
    return { ok: false, reason: "capture_session_run_mismatch" };
  }

  return {
    ok: true,
    proof: {
      invoiceId,
      customerId: input.expectedCustomerId,
      subscriptionId: input.expectedSubscriptionId,
      sessionId: input.expectedSessionId,
      runId: input.expectedRunId,
    },
  };
}
