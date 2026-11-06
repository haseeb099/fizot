export const DAY_MS = 86_400_000;
export const GRACE_WINDOW_MS = 7 * DAY_MS;
export const DELETE_AFTER_SUSPEND_MS = 30 * DAY_MS;
export const NOTICE_BEFORE_DELETE_MS = 7 * DAY_MS;

export type BillingStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "suspended"
  | "canceled"
  | "deleted";

export type BillingRecord = {
  workspaceId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeItemId: string | null;
  status: BillingStatus;
  /** Newest applied Stripe event `created` (seconds). Older events are ignored. */
  objectVersion: number;
  paymentMethod: boolean;
  quantity: number;
  priceId: string | null;
  plan: "home" | "team" | null;
  firstFailureAt: number | null;
  suspendedAt: number | null;
  noticeSentAt: number | null;
  deletionRequestedAt: number | null;
  country: string | null;
  vatId: string | null;
  lastFinalizedInvoiceId: string | null;
  finalizedVersion: number;
};

export type LifecycleAction = "suspend" | "notice" | "delete";

export function emptyRecord(workspaceId: string): BillingRecord {
  return {
    workspaceId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeItemId: null,
    status: "none",
    objectVersion: 0,
    paymentMethod: false,
    quantity: 1,
    priceId: null,
    plan: null,
    firstFailureAt: null,
    suspendedAt: null,
    noticeSentAt: null,
    deletionRequestedAt: null,
    country: null,
    vatId: null,
    lastFinalizedInvoiceId: null,
    finalizedVersion: 0,
  };
}

/** Active, or trialing with a payment method, or still inside grace. */
export function proxyAllowed(record: BillingRecord | null): boolean {
  if (!record) return false;
  if (record.status === "active") return true;
  if (record.status === "trialing" && record.paymentMethod) return true;
  if (record.status === "past_due" || record.status === "grace") return true;
  return false;
}

export function mapStripeStatus(status: string): BillingStatus | null {
  if (status === "active" || status === "past_due" || status === "trialing") return status;
  if (status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  if (status === "incomplete") return "none";
  return null;
}

/**
 * Move past_due into the 7-day grace, then suspend, then notice, then delete.
 * Times come only from stored timestamps and `now`.
 */
export function advanceLifecycle(record: BillingRecord, now: number): { record: BillingRecord; actions: LifecycleAction[] } {
  const actions: LifecycleAction[] = [];
  if (record.status === "suspended" && record.suspendedAt != null && record.deletionRequestedAt == null) {
    const deleteAt = record.suspendedAt + DELETE_AFTER_SUSPEND_MS;
    if (now >= deleteAt - NOTICE_BEFORE_DELETE_MS && record.noticeSentAt == null) actions.push("notice");
    if (now >= deleteAt) actions.push("delete");
    return { record, actions };
  }
  if ((record.status !== "past_due" && record.status !== "grace") || record.firstFailureAt == null) {
    return { record, actions };
  }
  if (now >= record.firstFailureAt + GRACE_WINDOW_MS) {
    return {
      record: { ...record, status: "suspended", suspendedAt: record.firstFailureAt + GRACE_WINDOW_MS },
      actions: ["suspend"],
    };
  }
  if (record.status === "past_due") {
    return { record: { ...record, status: "grace" }, actions };
  }
  return { record, actions };
}

export function recovering(status: BillingStatus): boolean {
  return status === "active" || status === "trialing";
}
