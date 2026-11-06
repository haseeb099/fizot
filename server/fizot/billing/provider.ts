export type CheckoutInput = {
  priceId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
  workspaceId: string;
  customerEmail: string;
  country: string;
  vatId: string;
  plan: "home" | "team";
};

export type PortalInput = {
  customerId: string;
  returnUrl: string;
  workspaceId: string;
};

export interface BillingProvider {
  createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string; customerId: string }>;
  createPortalSession(input: PortalInput): Promise<{ url: string }>;
  updateSubscriptionQuantity(subscriptionId: string, quantity: number, itemId: string | null): Promise<void>;
}

export type FakeBillingProvider = BillingProvider & {
  checkouts: CheckoutInput[];
  portals: PortalInput[];
  quantities: Array<{ subscriptionId: string; quantity: number }>;
};

export function createFakeBillingProvider(): FakeBillingProvider {
  const checkouts: CheckoutInput[] = [];
  const portals: PortalInput[] = [];
  const quantities: Array<{ subscriptionId: string; quantity: number }> = [];
  return {
    checkouts,
    portals,
    quantities,
    async createCheckoutSession(input) {
      checkouts.push(input);
      const id = `cs_test_${checkouts.length}`;
      return { id, url: `https://checkout.stripe.test/c/${id}`, customerId: `cus_test_${input.workspaceId}` };
    },
    async createPortalSession(input) {
      portals.push(input);
      return { url: `https://billing.stripe.test/session/${portals.length}` };
    },
    async updateSubscriptionQuantity(subscriptionId, quantity) {
      quantities.push({ subscriptionId, quantity });
    },
  };
}

export function createUnconfiguredBillingProvider(): BillingProvider {
  const fail = async () => {
    throw Object.assign(new Error("stripe_unconfigured"), { code: "stripe_unconfigured" });
  };
  return {
    createCheckoutSession: fail,
    createPortalSession: fail,
    updateSubscriptionQuantity: fail,
  };
}

type FetchLike = typeof fetch;

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

async function stripeRequest(
  key: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> | null,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`stripe_${res.status}:${redact(text, key).slice(0, 180)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export function createStripeBillingProvider(key: string, fetchImpl: FetchLike = fetch): BillingProvider {
  return {
    async createCheckoutSession(input) {
      const customer = await stripeRequest(key, "POST", "customers", {
        email: input.customerEmail,
        "address[country]": input.country,
        "metadata[workspace_id]": input.workspaceId,
      }, fetchImpl);
      const customerId = String(customer.id ?? "");
      if (input.vatId) {
        const type = input.country.toUpperCase() === "GB" ? "gb_vat" : "eu_vat";
        await stripeRequest(key, "POST", `customers/${customerId}/tax_ids`, { type, value: input.vatId }, fetchImpl);
      }
      const session = await stripeRequest(key, "POST", "checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.workspaceId,
        "line_items[0][price]": input.priceId,
        "line_items[0][quantity]": String(input.quantity),
        "automatic_tax[enabled]": "true",
        "tax_id_collection[enabled]": "true",
        "billing_address_collection": "required",
        "metadata[workspace_id]": input.workspaceId,
        "metadata[plan]": input.plan,
        "subscription_data[metadata][workspace_id]": input.workspaceId,
        "subscription_data[metadata][plan]": input.plan,
      }, fetchImpl);
      const url = String(session.url ?? "");
      if (!url) throw new Error("stripe_checkout_missing_url");
      return { id: String(session.id ?? ""), url, customerId };
    },
    async createPortalSession(input) {
      const session = await stripeRequest(key, "POST", "billing_portal/sessions", {
        customer: input.customerId,
        return_url: input.returnUrl,
      }, fetchImpl);
      const url = String(session.url ?? "");
      if (!url) throw new Error("stripe_portal_missing_url");
      return { url };
    },
    async updateSubscriptionQuantity(subscriptionId, quantity, itemId) {
      let item = itemId;
      if (!item) {
        const sub = await stripeRequest(key, "GET", `subscriptions/${subscriptionId}`, null, fetchImpl);
        const items = sub.items as { data?: Array<{ id?: string }> } | undefined;
        item = items?.data?.[0]?.id ?? null;
      }
      if (!item) throw new Error("stripe_subscription_item_missing");
      await stripeRequest(key, "POST", `subscriptions/${subscriptionId}`, {
        "items[0][id]": item,
        "items[0][quantity]": String(quantity),
      }, fetchImpl);
    },
  };
}
