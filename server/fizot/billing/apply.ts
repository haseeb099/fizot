import type { CreditStore } from "../proxy/credit-store.ts";
import type { EmailProvider } from "./email.ts";
import { planPrice, vatGate, type PlanPrice } from "./plan-prices.ts";
import type { BillingProvider } from "./provider.ts";
import {
  advanceLifecycle,
  DELETE_AFTER_SUSPEND_MS,
  emptyRecord,
  mapStripeStatus,
  proxyAllowed,
  recovering,
  type BillingRecord,
  type BillingStatus,
} from "./record.ts";
import type { BillingStore } from "./store.ts";

export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

export type ApplyResult = {
  applied: boolean;
  stale: boolean;
  status: BillingStatus | "missing";
  previousStatus: BillingStatus | null;
  workspaceId: string | null;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function metaOf(object: Record<string, unknown>): Record<string, unknown> {
  const meta = object.metadata;
  return meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
}

function workspaceFrom(object: Record<string, unknown>): string | null {
  return str(metaOf(object).workspace_id) ?? str(object.client_reference_id);
}

function planFrom(object: Record<string, unknown>, fallback: BillingRecord["plan"]): BillingRecord["plan"] {
  const raw = str(metaOf(object).plan) ?? fallback;
  return raw === "home" || raw === "team" ? raw : fallback;
}

function paymentMethodPresent(object: Record<string, unknown>): boolean {
  return Boolean(object.default_payment_method || object.payment_method || object.payment_status === "paid");
}

function itemOf(object: Record<string, unknown>): { id: string | null; quantity: number; priceId: string | null } {
  const items = object.items as { data?: Array<Record<string, unknown>> } | undefined;
  const first = items?.data?.[0];
  const price = first?.price as { id?: string } | string | undefined;
  const priceId = typeof price === "string" ? price : str(price?.id);
  const quantity = typeof first?.quantity === "number" ? first.quantity : 1;
  return { id: str(first?.id), quantity, priceId };
}

export async function applyStripeEvent(input: {
  store: BillingStore;
  credit: CreditStore;
  event: StripeEvent;
  now?: number;
}): Promise<ApplyResult> {
  const object = input.event.data?.object ?? {};
  const created = input.event.created;
  const located = await locate(input.store, object);
  const workspaceId = located?.workspaceId ?? workspaceFrom(object);
  if (!workspaceId) return { applied: false, stale: false, status: "missing", previousStatus: null, workspaceId: null };
  const current = located ?? (await input.store.get(workspaceId)) ?? emptyRecord(workspaceId);
  const previousStatus = current.status;
  if (input.event.type === "invoice.finalized") {
    if (created >= current.finalizedVersion) {
      current.lastFinalizedInvoiceId = str(object.id);
      current.finalizedVersion = created;
      await input.store.save(current);
    }
    return { applied: true, stale: created < current.finalizedVersion, status: current.status, previousStatus, workspaceId };
  }
  if (input.event.type === "customer.updated") {
    if (created < current.objectVersion) {
      return { applied: false, stale: true, status: current.status, previousStatus, workspaceId };
    }
    current.country = str((object.address as { country?: string } | undefined)?.country) ?? current.country;
    current.objectVersion = created;
    await input.store.save(current);
    return { applied: true, stale: false, status: current.status, previousStatus, workspaceId };
  }
  if (created < current.objectVersion && input.event.type !== "invoice.paid") {
    return { applied: false, stale: true, status: current.status, previousStatus, workspaceId };
  }
  if (input.event.type === "invoice.paid") {
    current.plan = planFrom(object, current.plan);
    await grantIncluded(input.credit, current, object);
    if (created >= current.objectVersion) {
      clearFailure(current);
      current.status = "active";
      current.objectVersion = created;
      current.paymentMethod = true;
    }
    await input.store.save(current);
    return { applied: true, stale: created < previousVersion(current, created), status: current.status, previousStatus, workspaceId };
  }
  if (created < current.objectVersion) {
    return { applied: false, stale: true, status: current.status, previousStatus, workspaceId };
  }
  current.objectVersion = created;
  current.plan = planFrom(object, current.plan);
  const customer = str(object.customer);
  if (customer) current.stripeCustomerId = customer;
  if (input.event.type === "checkout.session.completed") {
    current.stripeSubscriptionId = str(object.subscription) ?? current.stripeSubscriptionId;
    current.paymentMethod = paymentMethodPresent(object) || current.paymentMethod;
    if (current.status === "none") current.status = current.paymentMethod ? "active" : "none";
  } else if (input.event.type === "invoice.payment_failed") {
    current.stripeSubscriptionId = str(object.subscription) ?? current.stripeSubscriptionId;
    if (current.status !== "deleted") {
      current.status = "past_due";
      current.firstFailureAt = current.firstFailureAt ?? created * 1000;
    }
  } else if (
    input.event.type === "customer.subscription.created"
    || input.event.type === "customer.subscription.updated"
    || input.event.type === "customer.subscription.deleted"
  ) {
    current.stripeSubscriptionId = str(object.id) ?? current.stripeSubscriptionId;
    const item = itemOf(object);
    current.stripeItemId = item.id ?? current.stripeItemId;
    current.quantity = item.quantity;
    current.priceId = item.priceId ?? current.priceId;
    current.paymentMethod = paymentMethodPresent(object) || current.paymentMethod;
    const mapped = input.event.type === "customer.subscription.deleted"
      ? "canceled"
      : mapStripeStatus(str(object.status) ?? "") ?? current.status;
    if (recovering(mapped)) clearFailure(current);
    if (mapped === "past_due") current.firstFailureAt = current.firstFailureAt ?? created * 1000;
    current.status = mapped;
  }
  await input.store.save(current);
  return { applied: true, stale: false, status: current.status, previousStatus, workspaceId };
}

function previousVersion(record: BillingRecord, created: number): number {
  return created < record.objectVersion ? record.objectVersion : created;
}

async function locate(store: BillingStore, object: Record<string, unknown>): Promise<BillingRecord | null> {
  const workspaceId = workspaceFrom(object);
  if (workspaceId) return (await store.get(workspaceId)) ?? emptyRecord(workspaceId);
  const customer = str(object.customer) ?? (str(object.object) === "customer" ? str(object.id) : null);
  if (customer) {
    const row = await store.findByCustomer(customer);
    if (row) return row;
  }
  const subscription = str(object.subscription) ?? (str(object.object) === "subscription" ? str(object.id) : null);
  if (subscription) return store.findBySubscription(subscription);
  return null;
}

function clearFailure(record: BillingRecord): void {
  record.firstFailureAt = null;
  record.suspendedAt = null;
  record.noticeSentAt = null;
  record.deletionRequestedAt = null;
}

async function grantIncluded(credit: CreditStore, record: BillingRecord, object: Record<string, unknown>): Promise<void> {
  const invoiceId = str(object.id);
  const price = record.plan ? planPrice(record.plan) : null;
  if (!invoiceId || !price) return;
  await credit.ensureAccount(record.workspaceId, price.includedCreditMicroGbp);
  await credit.setIncluded(record.workspaceId, price.includedCreditMicroGbp);
  await credit.grant({
    workspaceId: record.workspaceId,
    amountMicroGbp: price.includedCreditMicroGbp,
    requestId: invoiceId,
    kind: "grant",
    meta: { source: "invoice.paid" },
  });
}

export type BillingUrls = { successUrl: string; cancelUrl: string; portalReturnUrl: string };

export type BillingService = {
  store: BillingStore;
  allows(workspaceId: string): Promise<boolean>;
  checkout(input: {
    workspaceId: string;
    plan: string;
    email: string;
    country?: string;
    vatId?: string;
    memberCount: number;
    testMode: boolean;
  }): Promise<{ status: number; body: Record<string, unknown> }>;
  portal(input: { workspaceId: string; testMode: boolean }): Promise<{ status: number; body: Record<string, unknown> }>;
  applyEvent(event: StripeEvent): Promise<ApplyResult>;
  syncSeats(workspaceId: string, plan: string, memberCount: number): Promise<void>;
  tick(now: number): Promise<Array<{ workspaceId: string; status: BillingStatus; actions: string[] }>>;
  close(): Promise<void>;
};

export function createBillingService(input: {
  store: BillingStore;
  credit: CreditStore;
  provider: BillingProvider;
  email: EmailProvider;
  urls: BillingUrls;
  ownerEmail?: (workspaceId: string) => Promise<string | null>;
  onSuspend?: (workspaceId: string) => Promise<void>;
  onResume?: (workspaceId: string) => Promise<void>;
  onDelete?: (workspaceId: string) => Promise<void>;
}): BillingService {
  return {
    store: input.store,
    async allows(workspaceId) {
      return proxyAllowed(await input.store.get(workspaceId));
    },
    async checkout(req) {
      const price = planPrice(req.plan);
      if (!price) return { status: 400, body: { error: "unknown_plan" } };
      const country = (req.country ?? "GB").toUpperCase();
      const vatId = req.vatId?.trim() ?? "";
      if (vatGate(country, vatId) === "vat_id_required") return { status: 400, body: { error: "vat_id_required" } };
      if (price.publication !== "published" && !req.testMode) return { status: 403, body: { error: "plan_unpublished" } };
      const quantity = price.seats === "per_seat" ? Math.max(1, req.memberCount) : 1;
      try {
        const session = await input.provider.createCheckoutSession({
          priceId: price.stripePriceId,
          quantity,
          successUrl: input.urls.successUrl,
          cancelUrl: input.urls.cancelUrl,
          workspaceId: req.workspaceId,
          customerEmail: req.email,
          country,
          vatId,
          plan: price.plan,
        });
        const record = (await input.store.get(req.workspaceId)) ?? emptyRecord(req.workspaceId);
        record.plan = price.plan;
        record.stripeCustomerId = session.customerId;
        record.country = country;
        record.vatId = vatId || null;
        record.quantity = quantity;
        record.priceId = price.stripePriceId;
        await input.store.save(record);
        return { status: 200, body: { url: session.url } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "stripe_unavailable";
        const code = message.startsWith("stripe_") ? message.split(":")[0] : "stripe_unavailable";
        return { status: 502, body: { error: code } };
      }
    },
    async portal(req) {
      const record = await input.store.get(req.workspaceId);
      const customerId = record?.stripeCustomerId ?? (req.testMode ? `cus_test_${req.workspaceId}` : null);
      if (!customerId) return { status: 409, body: { error: "customer_missing" } };
      try {
        const session = await input.provider.createPortalSession({
          customerId,
          returnUrl: input.urls.portalReturnUrl,
          workspaceId: req.workspaceId,
        });
        return { status: 200, body: { url: session.url } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "stripe_unavailable";
        return { status: 502, body: { error: message.startsWith("stripe_") ? message.split(":")[0] : "stripe_unavailable" } };
      }
    },
    async applyEvent(event) {
      const result = await applyStripeEvent({ store: input.store, credit: input.credit, event });
      if (
        result.workspaceId
        && result.previousStatus === "suspended"
        && (result.status === "active" || result.status === "trialing")
      ) {
        await input.onResume?.(result.workspaceId);
      }
      return result;
    },
    async syncSeats(workspaceId, plan, memberCount) {
      if (plan !== "team") return;
      const record = await input.store.get(workspaceId);
      if (!record?.stripeSubscriptionId) return;
      const quantity = Math.max(1, memberCount);
      if (quantity === record.quantity) return;
      await input.provider.updateSubscriptionQuantity(record.stripeSubscriptionId, quantity, record.stripeItemId);
      record.quantity = quantity;
      await input.store.save(record);
    },
    async tick(now) {
      const rows = await input.store.list();
      const out: Array<{ workspaceId: string; status: BillingStatus; actions: string[] }> = [];
      for (const row of rows) {
        const stepped = advanceLifecycle(row, now);
        const actions = [...stepped.actions];
        let record = stepped.record;
        if (actions.includes("suspend")) await input.onSuspend?.(record.workspaceId);
        if (actions.includes("notice")) {
          const to = (await input.ownerEmail?.(record.workspaceId)) ?? "";
          const deleteAt = (record.suspendedAt ?? now) + DELETE_AFTER_SUSPEND_MS;
          if (to) {
            await input.email.send({
              to,
              subject: "Workspace deletion scheduled",
              text: `Workspace ${record.workspaceId} will be deleted at ${new Date(deleteAt).toISOString()} if payment is not recovered.`,
            });
          }
          record = { ...record, noticeSentAt: now };
        }
        if (actions.includes("delete")) {
          await input.onDelete?.(record.workspaceId);
          record = { ...record, status: "deleted", deletionRequestedAt: now };
        }
        if (actions.length > 0 || record.status !== row.status) await input.store.save(record);
        out.push({ workspaceId: record.workspaceId, status: record.status, actions });
      }
      return out;
    },
    close() {
      return input.store.close();
    },
  };
}

export function snapshotRecord(record: BillingRecord): BillingRecord {
  return { ...record };
}

export type { PlanPrice };
