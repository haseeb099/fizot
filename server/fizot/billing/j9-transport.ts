import { redactSecrets } from "./j9-config.ts";

export type J9StripeTransport = {
  request(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string> | null): Promise<Record<string, unknown>>;
};

type FetchLike = typeof fetch;

export function createLiveStripeTransport(apiKey: string, fetchImpl: FetchLike = fetch): J9StripeTransport {
  return {
    async request(method, path, params = null) {
      const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
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

/**
 * In-memory Stripe stand-in for unit tests. Does not contact the network.
 * Checkout creation is not treated as payment; createSubscription issues the paid invoice.
 */
export function createFakeStripeTransport(): J9StripeTransport & {
  customers: string[];
  subscriptions: string[];
  checkoutSessions: string[];
  deletedCustomers: string[];
  deletedSubscriptions: string[];
  quantities: Array<{ subscriptionId: string; quantity: number }>;
} {
  let seq = 0;
  const customers: string[] = [];
  const subscriptions: string[] = [];
  const checkoutSessions: string[] = [];
  const deletedCustomers: string[] = [];
  const deletedSubscriptions: string[] = [];
  const quantities: Array<{ subscriptionId: string; quantity: number }> = [];
  const subItems = new Map<string, { id: string; price: string; quantity: number }>();
  const customerMeta = new Map<string, Record<string, string>>();

  return {
    customers,
    subscriptions,
    checkoutSessions,
    deletedCustomers,
    deletedSubscriptions,
    quantities,
    async request(method, path, params = null) {
      seq += 1;
      if (method === "POST" && path === "customers") {
        const id = `cus_j9_${seq}`;
        customers.push(id);
        customerMeta.set(id, {
          workspace_id: params?.["metadata[workspace_id]"] ?? "",
          email: params?.email ?? "",
          country: params?.["address[country]"] ?? "GB",
        });
        return { id, object: "customer", email: params?.email ?? null, metadata: { workspace_id: params?.["metadata[workspace_id]"] ?? "" } };
      }
      if (method === "POST" && path === "checkout/sessions") {
        const id = `cs_j9_${seq}`;
        checkoutSessions.push(id);
        return {
          id,
          object: "checkout.session",
          mode: "subscription",
          url: `https://checkout.stripe.test/c/${id}`,
          customer: params?.customer ?? null,
          client_reference_id: params?.client_reference_id ?? null,
          automatic_tax: { enabled: params?.["automatic_tax[enabled]"] === "true" },
          tax_id_collection: { enabled: params?.["tax_id_collection[enabled]"] === "true" },
          metadata: {
            workspace_id: params?.["metadata[workspace_id]"] ?? "",
            plan: params?.["metadata[plan]"] ?? "",
          },
          line_items: {
            data: [{ price: { id: params?.["line_items[0][price]"] }, quantity: Number(params?.["line_items[0][quantity]"] ?? 1) }],
          },
        };
      }
      if (method === "POST" && path === "payment_methods") {
        return { id: `pm_j9_${seq}`, object: "payment_method", type: "card" };
      }
      if (method === "POST" && /^customers\/[^/]+\/payment_methods\/[^/]+\/attach$/.test(path)) {
        return { id: path.split("/")[3], object: "payment_method" };
      }
      if (method === "POST" && path === "subscriptions") {
        const id = `sub_j9_${seq}`;
        const itemId = `si_j9_${seq}`;
        const price = params?.["items[0][price]"] ?? "price_j9";
        const quantity = Number(params?.["items[0][quantity]"] ?? 1);
        subscriptions.push(id);
        subItems.set(id, { id: itemId, price, quantity });
        const invoiceId = `in_j9_${seq}`;
        return {
          id,
          object: "subscription",
          status: "active",
          customer: params?.customer ?? null,
          default_payment_method: params?.default_payment_method ?? `pm_j9_${seq}`,
          metadata: {
            workspace_id: params?.["metadata[workspace_id]"] ?? "",
            plan: params?.["metadata[plan]"] ?? "home",
          },
          items: { data: [{ id: itemId, quantity, price: { id: price } }] },
          latest_invoice: {
            id: invoiceId,
            object: "invoice",
            status: "paid",
            customer: params?.customer ?? null,
            subscription: id,
            metadata: {
              workspace_id: params?.["metadata[workspace_id]"] ?? "",
              plan: params?.["metadata[plan]"] ?? "home",
            },
            total_excluding_tax: 1999,
            tax: 400,
            total: 2399,
            automatic_tax: { status: "complete" },
          },
        };
      }
      if (method === "POST" && /^subscriptions\/[^/]+$/.test(path) && params?.["items[0][quantity]"]) {
        const id = path.split("/")[1]!;
        const item = subItems.get(id);
        if (item) {
          item.quantity = Number(params["items[0][quantity]"]);
          quantities.push({ subscriptionId: id, quantity: item.quantity });
        }
        return { id, object: "subscription", items: { data: item ? [{ id: item.id, quantity: item.quantity, price: { id: item.price } }] : [] } };
      }
      if (method === "GET" && /^subscriptions\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        const item = subItems.get(id);
        return {
          id,
          object: "subscription",
          status: "active",
          items: { data: item ? [{ id: item.id, quantity: item.quantity, price: { id: item.price } }] : [] },
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
        deletedSubscriptions.push(id);
        return { id, object: "subscription", status: "canceled" };
      }
      if (method === "DELETE" && /^customers\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        deletedCustomers.push(id);
        return { id, object: "customer", deleted: true };
      }
      throw new Error(`fake_stripe_unhandled:${method}:${path}`);
    },
  };
}
