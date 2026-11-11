/**
 * Paid-invoice checks for J9. Never invents a paid invoice or rewrites Stripe fields.
 */
export type PaidInvoiceExpectation = {
  customerId: string;
  subscriptionId: string;
};

export type PaidInvoiceResult =
  | { ok: true; invoiceId: string; livemode: false; paid: true }
  | { ok: false; reason: string };

function requireId(value: unknown, prefix: string): string | null {
  return typeof value === "string" && value.startsWith(prefix) ? value : null;
}

export function invoiceIdFromSubscription(subscription: Record<string, unknown>): string | null {
  const latest = subscription.latest_invoice;
  if (typeof latest === "string") return requireId(latest, "in_");
  if (latest && typeof latest === "object") {
    return requireId((latest as { id?: unknown }).id, "in_");
  }
  return null;
}

export function assertPaidInvoice(
  invoice: Record<string, unknown> | null | undefined,
  expected: PaidInvoiceExpectation,
): PaidInvoiceResult {
  if (invoice == null || typeof invoice !== "object" || Array.isArray(invoice)) {
    return { ok: false, reason: "invoice_missing" };
  }
  if (invoice.object !== "invoice") {
    return { ok: false, reason: "not_an_invoice" };
  }
  const invoiceId = requireId(invoice.id, "in_");
  if (!invoiceId) {
    return { ok: false, reason: "invoice_id_missing" };
  }
  if (!Object.prototype.hasOwnProperty.call(invoice, "livemode")) {
    return { ok: false, reason: "invoice_livemode_missing" };
  }
  if (invoice.livemode !== false) {
    return { ok: false, reason: invoice.livemode === true ? "invoice_livemode_true" : "invoice_livemode_invalid" };
  }
  if (!Object.prototype.hasOwnProperty.call(invoice, "paid")) {
    return { ok: false, reason: "invoice_paid_missing" };
  }
  if (invoice.paid !== true) {
    return { ok: false, reason: invoice.paid === false ? "invoice_paid_flag_false" : "invoice_paid_invalid" };
  }
  if (invoice.status !== "paid") {
    return { ok: false, reason: `invoice_status=${String(invoice.status)}` };
  }
  const customerId = requireId(invoice.customer, "cus_");
  if (!customerId) {
    return { ok: false, reason: "invoice_customer_missing" };
  }
  if (customerId !== expected.customerId) {
    return { ok: false, reason: "invoice_customer_mismatch" };
  }
  const subscriptionId = requireId(invoice.subscription, "sub_");
  if (!subscriptionId) {
    return { ok: false, reason: "invoice_subscription_missing" };
  }
  if (subscriptionId !== expected.subscriptionId) {
    return { ok: false, reason: "invoice_subscription_mismatch" };
  }
  return { ok: true, invoiceId, livemode: false, paid: true };
}

export function stripeQuantity(subscription: Record<string, unknown>): { itemId: string | null; quantity: number | null } {
  const items = subscription.items as { data?: Array<{ id?: string; quantity?: number }> } | undefined;
  const first = items?.data?.[0];
  return {
    itemId: typeof first?.id === "string" ? first.id : null,
    quantity: typeof first?.quantity === "number" ? first.quantity : null,
  };
}
