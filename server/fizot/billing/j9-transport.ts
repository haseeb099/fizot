import { redactSecrets } from "./j9-config.ts";

export type J9StripeTransport = {
  request(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string> | null): Promise<Record<string, unknown>>;
};

export type FakeStripeTransport = J9StripeTransport & {
  customers: string[];
  subscriptions: string[];
  checkoutSessions: string[];
  deletedCustomers: string[];
  deletedSubscriptions: string[];
  expiredSessions: string[];
  quantities: Array<{ subscriptionId: string; quantity: number }>;
  /** Fake-only: mark a Checkout Session complete. Not a Stripe API. */
  markCheckoutComplete(sessionId: string): void;
  /** Test hook: refuse quantity updates so Stripe stays at 1. */
  freezeQuantity: boolean;
  /** Test hook: fail cleanup deletes. */
  failCleanup: boolean;
};

type FetchLike = typeof fetch;

export function createLiveStripeTransport(apiKey: string, fetchImpl: FetchLike = fetch): J9StripeTransport {
  return {
    async request(method, path, params = null) {
      const url = new URL(`https://api.stripe.com/v1/${path}`);
      if (method === "GET" && params) {
        for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value);
      }
      const res = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(params && method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        body: params && method !== "GET" ? new URLSearchParams(params).toString() : undefined,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`stripe_${res.status}:${redactSecrets(text, [apiKey]).slice(0, 180)}`);
      }
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    },
  };
}

export type FakeStripeOptions = {
  /** Default paid. Set open/unpaid to exercise missing-payment paths. */
  invoiceStatus?: "paid" | "open" | "draft";
};

/**
 * In-memory Stripe stand-in for unit tests. Does not contact the network.
 * Checkout creation leaves sessions open until markCheckoutComplete.
 */
export function createFakeStripeTransport(options: FakeStripeOptions = {}): FakeStripeTransport {
  const invoiceStatus = options.invoiceStatus ?? "paid";
  let seq = 0;
  const customers: string[] = [];
  const subscriptions: string[] = [];
  const checkoutSessions: string[] = [];
  const deletedCustomers: string[] = [];
  const deletedSubscriptions: string[] = [];
  const expiredSessions: string[] = [];
  const quantities: Array<{ subscriptionId: string; quantity: number }> = [];
  const subItems = new Map<string, { id: string; price: string; quantity: number; customer: string; metadata: Record<string, string> }>();
  const invoices = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const deletedSubs = new Set<string>();
  const deletedCust = new Set<string>();

  const transport: FakeStripeTransport = {
    customers,
    subscriptions,
    checkoutSessions,
    deletedCustomers,
    deletedSubscriptions,
    expiredSessions,
    quantities,
    freezeQuantity: false,
    failCleanup: false,
    markCheckoutComplete(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`fake_checkout_missing:${sessionId}`);
      session.status = "complete";
      session.payment_status = "paid";
      session.subscription = `sub_checkout_${sessionId}`;
    },
    async request(method, path, params = null) {
      seq += 1;
      if (method === "POST" && path === "customers") {
        const id = `cus_j9_${seq}`;
        customers.push(id);
        return {
          id,
          object: "customer",
          livemode: false,
          email: params?.email ?? null,
          metadata: { workspace_id: params?.["metadata[workspace_id]"] ?? "" },
        };
      }
      if (method === "POST" && path === "checkout/sessions") {
        const id = `cs_j9_${seq}`;
        checkoutSessions.push(id);
        const session = {
          id,
          object: "checkout.session",
          livemode: false,
          mode: "subscription",
          status: "open",
          payment_status: "unpaid",
          url: `https://checkout.stripe.test/c/${id}`,
          customer: params?.customer ?? null,
          subscription: null,
          client_reference_id: params?.client_reference_id ?? null,
          automatic_tax: { enabled: params?.["automatic_tax[enabled]"] === "true" },
          tax_id_collection: { enabled: params?.["tax_id_collection[enabled]"] === "true" },
          metadata: {
            workspace_id: params?.["metadata[workspace_id]"] ?? "",
            plan: params?.["metadata[plan]"] ?? "",
          },
        };
        sessions.set(id, session);
        return { ...session };
      }
      if (method === "GET" && /^checkout\/sessions\/[^/]+$/.test(path)) {
        const id = path.split("/")[2]!;
        const session = sessions.get(id);
        if (!session) throw new Error(`stripe_404:checkout_session_missing`);
        return { ...session };
      }
      if (method === "POST" && /^checkout\/sessions\/[^/]+\/expire$/.test(path)) {
        const id = path.split("/")[2]!;
        const session = sessions.get(id);
        if (!session) throw new Error(`stripe_404:checkout_session_missing`);
        if (session.status === "expired") return { ...session };
        if (session.status === "complete") throw new Error(`stripe_400:session_already_complete`);
        session.status = "expired";
        expiredSessions.push(id);
        return { ...session };
      }
      if (method === "POST" && path === "payment_methods") {
        return { id: `pm_j9_${seq}`, object: "payment_method", type: "card", livemode: false };
      }
      // Official Stripe path: POST /v1/payment_methods/:id/attach
      if (method === "POST" && /^payment_methods\/[^/]+\/attach$/.test(path)) {
        return { id: path.split("/")[1], object: "payment_method", customer: params?.customer ?? null };
      }
      if (method === "POST" && path === "subscriptions") {
        const id = `sub_j9_${seq}`;
        const itemId = `si_j9_${seq}`;
        const invoiceId = `in_j9_${seq}`;
        const price = params?.["items[0][price]"] ?? "price_j9";
        const quantity = Number(params?.["items[0][quantity]"] ?? 1);
        const customer = String(params?.customer ?? "");
        const metadata = {
          workspace_id: params?.["metadata[workspace_id]"] ?? "",
          plan: params?.["metadata[plan]"] ?? "home",
        };
        subscriptions.push(id);
        subItems.set(id, { id: itemId, price, quantity, customer, metadata });
        const invoice = {
          id: invoiceId,
          object: "invoice",
          livemode: false,
          status: invoiceStatus,
          paid: invoiceStatus === "paid",
          customer,
          subscription: id,
          amount_paid: invoiceStatus === "paid" ? 2399 : 0,
          metadata: { ...metadata },
        };
        invoices.set(invoiceId, invoice);
        const expandInvoice = params?.["expand[]"] === "latest_invoice" || params?.["expand[0]"] === "latest_invoice";
        return {
          id,
          object: "subscription",
          livemode: false,
          status: invoiceStatus === "paid" ? "active" : "incomplete",
          customer,
          default_payment_method: params?.default_payment_method ?? null,
          metadata,
          items: { data: [{ id: itemId, quantity, price: { id: price } }] },
          latest_invoice: expandInvoice ? { ...invoice } : invoiceId,
        };
      }
      if (method === "GET" && /^invoices\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        const invoice = invoices.get(id);
        if (!invoice) throw new Error(`stripe_404:invoice_missing`);
        return { ...invoice };
      }
      if (method === "POST" && /^subscriptions\/[^/]+$/.test(path) && params?.["items[0][quantity]"]) {
        const id = path.split("/")[1]!;
        if (deletedSubs.has(id)) throw new Error(`stripe_404:subscription_missing`);
        const item = subItems.get(id);
        const itemId = params["items[0][id]"];
        if (!item || !itemId || itemId !== item.id) {
          throw new Error(`stripe_400:subscription_item_mismatch`);
        }
        if (!transport.freezeQuantity) {
          item.quantity = Number(params["items[0][quantity]"]);
          quantities.push({ subscriptionId: id, quantity: item.quantity });
        }
        return {
          id,
          object: "subscription",
          items: { data: [{ id: item.id, quantity: item.quantity, price: { id: item.price } }] },
        };
      }
      if (method === "GET" && /^subscriptions\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        if (deletedSubs.has(id)) throw new Error(`stripe_404:subscription_missing`);
        const item = subItems.get(id);
        if (!item) throw new Error(`stripe_404:subscription_missing`);
        return {
          id,
          object: "subscription",
          livemode: false,
          status: "active",
          customer: item.customer,
          metadata: item.metadata,
          items: { data: [{ id: item.id, quantity: item.quantity, price: { id: item.price } }] },
        };
      }
      if (method === "POST" && path === "tax/calculations") {
        const country = params?.["customer_details[address][country]"] ?? "GB";
        const hasTaxId = Boolean(params?.["customer_details[tax_ids][0][value]"]);
        if (country === "GB") {
          return {
            id: `taxcalc_j9_${seq}`,
            tax_amount_exclusive: 400,
            tax_breakdown: [{ taxable_amount: 1999, tax_rate_details: { percentage_decimal: "20.0", country: "GB" } }],
          };
        }
        if (hasTaxId) {
          return {
            id: `taxcalc_j9_${seq}`,
            tax_amount_exclusive: 0,
            tax_breakdown: [{ taxable_amount: 1999, taxability_reason: "reverse_charge", tax_rate_details: { percentage_decimal: "0.0", country } }],
          };
        }
        throw new Error("stripe_400:vat_id_required_for_eu_business");
      }
      if (method === "DELETE" && /^subscriptions\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        if (transport.failCleanup) throw new Error("stripe_500:cleanup_failed");
        if (deletedSubs.has(id)) return { id, object: "subscription", status: "canceled" };
        deletedSubs.add(id);
        deletedSubscriptions.push(id);
        return { id, object: "subscription", status: "canceled" };
      }
      if (method === "DELETE" && /^customers\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        if (transport.failCleanup) throw new Error("stripe_500:cleanup_failed");
        if (deletedCust.has(id)) return { id, object: "customer", deleted: true };
        deletedCust.add(id);
        deletedCustomers.push(id);
        return { id, object: "customer", deleted: true };
      }
      throw new Error(`fake_stripe_unhandled:${method}:${path}`);
    },
  };
  return transport;
}
