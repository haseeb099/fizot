/**
 * Paid-invoice checks for J9. Never invents a paid invoice or rewrites Stripe fields.
 */
export type PaidInvoiceExpectation = {
  customerId: string;
  subscriptionId: string;
};

export type PaidInvoiceResult =
  | { ok: true; invoiceId: string; livemode: false }
  | { ok: false; reason: string };

export function invoiceIdFromSubscription(subscription: Record<string, unknown>): string | null {
  const latest = subscription.latest_invoice;
  if (typeof latest === "string" && latest.startsWith("in_")) return latest;
  if (latest && typeof latest === "object") {
    const id = (latest as { id?: unknown }).id;
    return typeof id === "string" && id.startsWith("in_") ? id : null;
  }
  return null;
}

export function assertPaidInvoice(
  invoice: Record<string, unknown> | null | undefined,
  expected: PaidInvoiceExpectation,
): PaidInvoiceResult {
  if (!invoice || typeof invoice !== "object") {
    return { ok: false, reason: "invoice_missing" };
  }
  if (invoice.object != null && invoice.object !== "invoice") {
    return { ok: false, reason: "not_an_invoice" };
  }
  const invoiceId = typeof invoice.id === "string" ? invoice.id : "";
  if (!invoiceId.startsWith("in_")) {
    return { ok: false, reason: "invoice_id_missing" };
  }
  if (invoice.status !== "paid") {
    return { ok: false, reason: `invoice_status=${String(invoice.status)}` };
  }
  if (invoice.livemode === true) {
    return { ok: false, reason: "invoice_livemode_true" };
  }
  if (String(invoice.customer ?? "") !== expected.customerId) {
    return { ok: false, reason: "invoice_customer_mismatch" };
  }
  if (String(invoice.subscription ?? "") !== expected.subscriptionId) {
    return { ok: false, reason: "invoice_subscription_mismatch" };
  }
  const paidFlag = invoice.paid;
  if (paidFlag === false) {
    return { ok: false, reason: "invoice_paid_flag_false" };
  }
  return { ok: true, invoiceId, livemode: false };
}

export function stripeQuantity(subscription: Record<string, unknown>): { itemId: string | null; quantity: number | null } {
  const items = subscription.items as { data?: Array<{ id?: string; quantity?: number }> } | undefined;
  const first = items?.data?.[0];
  return {
    itemId: typeof first?.id === "string" ? first.id : null,
    quantity: typeof first?.quantity === "number" ? first.quantity : null,
  };
}
