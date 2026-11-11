import { redactSecrets } from "./j9-config.ts";
import { J9StripeError, stripeErrorFromHttp } from "./j9-errors.ts";

export type J9StripeTransport = {
  request(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string> | null): Promise<Record<string, unknown>>;
};

export type FakeStripeTransport = J9StripeTransport & {
  customers: string[];
  subscriptions: string[];
  checkoutSessions: string[];
  testClocks: string[];
  deletedCustomers: string[];
  deletedSubscriptions: string[];
  deletedTestClocks: string[];
  expiredSessions: string[];
  quantities: Array<{ subscriptionId: string; quantity: number }>;
  events: Array<Record<string, unknown>>;
  /** Fake-only: mark a Checkout Session complete. Not a Stripe API. */
  markCheckoutComplete(sessionId: string): void;
  /** Fake-only: emit a Stripe-shaped event for Events API correlation tests. */
  pushEvent(event: Record<string, unknown>): void;
  /** Fake-only: set clock status after advance (ready|advancing|internal_failure). */
  clockAdvanceStatus: "ready" | "advancing" | "internal_failure";
  /** Test hook: refuse quantity updates so Stripe stays at 1. */
  freezeQuantity: boolean;
  /** Test hook: fail cleanup deletes/expires with a typed Stripe error. */
  failCleanup: boolean;
  cleanupFailStatus: number;
  cleanupFailCode: string;
  cleanupFailMessage: string;
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
        const err = stripeErrorFromHttp(res.status, text);
        throw new J9StripeError({
          status: err.status,
          code: err.code,
          stripeType: err.stripeType,
          message: redactSecrets(err.message, [apiKey]),
        });
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
  const testClocks: string[] = [];
  const deletedCustomers: string[] = [];
  const deletedSubscriptions: string[] = [];
  const deletedTestClocks: string[] = [];
  const expiredSessions: string[] = [];
  const quantities: Array<{ subscriptionId: string; quantity: number }> = [];
  const events: Array<Record<string, unknown>> = [];
  const subItems = new Map<string, {
    id: string;
    price: string;
    quantity: number;
    customer: string;
    metadata: Record<string, string>;
    defaultPaymentMethod: string | null;
  }>();
  const customerObjects = new Map<string, Record<string, unknown>>();
  const invoices = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const clocks = new Map<string, Record<string, unknown>>();
  const prices = new Map<string, Record<string, unknown>>();
  const deletedSubs = new Set<string>();
  const deletedCust = new Set<string>();
  const deletedClocks = new Set<string>();

  const transport: FakeStripeTransport = {
    customers,
    subscriptions,
    checkoutSessions,
    testClocks,
    deletedCustomers,
    deletedSubscriptions,
    deletedTestClocks,
    expiredSessions,
    quantities,
    events,
    clockAdvanceStatus: "ready",
    freezeQuantity: false,
    failCleanup: false,
    cleanupFailStatus: 500,
    cleanupFailCode: "api_error",
    cleanupFailMessage: "cleanup complete failed",
    markCheckoutComplete(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`fake_checkout_missing:${sessionId}`);
      session.status = "complete";
      session.payment_status = "paid";
      const subId = `sub_checkout_${sessionId}`;
      session.subscription = subId;
      if (!subscriptions.includes(subId)) {
        subscriptions.push(subId);
        const customer = String(session.customer ?? "");
        const metadata = { ...(session.metadata as Record<string, string> | undefined) };
        const price = String(session.line_price ?? "price_j9_test_home");
        const itemId = `si_checkout_${seq}`;
        const invoiceId = `in_checkout_${seq}`;
        subItems.set(subId, {
          id: itemId,
          price,
          quantity: 1,
          customer,
          metadata,
          defaultPaymentMethod: "pm_card_visa",
        });
        invoices.set(invoiceId, {
          id: invoiceId,
          object: "invoice",
          livemode: false,
          status: "paid",
          paid: true,
          customer,
          subscription: subId,
          amount_paid: 2399,
          metadata: { ...metadata },
        });
        (session as { latest_invoice_id?: string }).latest_invoice_id = invoiceId;
      }
    },
    pushEvent(event) {
      events.push(event);
    },
    async request(method, path, params = null) {
      seq += 1;
      if (method === "POST" && path === "test_helpers/test_clocks") {
        const id = `clock_j9_${seq}`;
        testClocks.push(id);
        const clock = {
          id,
          object: "test_helpers.test_clock",
          livemode: false,
          status: "ready",
          frozen_time: Number(params?.frozen_time ?? 0),
          name: params?.name ?? null,
        };
        clocks.set(id, clock);
        return { ...clock };
      }
      if (method === "GET" && /^test_helpers\/test_clocks\/[^/]+$/.test(path)) {
        const id = path.split("/")[2]!;
        const clock = clocks.get(id);
        if (!clock || deletedClocks.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:test_clock_missing" });
        }
        return { ...clock };
      }
      if (method === "POST" && /^test_helpers\/test_clocks\/[^/]+\/advance$/.test(path)) {
        const id = path.split("/")[2]!;
        const clock = clocks.get(id);
        if (!clock || deletedClocks.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:test_clock_missing" });
        }
        const target = Number(params?.frozen_time ?? 0);
        if (target <= Number(clock.frozen_time)) {
          throw new J9StripeError({ status: 400, code: "invalid_request_error", stripeType: "invalid_request_error", message: "stripe_400:frozen_time_must_increase" });
        }
        clock.status = transport.clockAdvanceStatus === "ready" ? "advancing" : transport.clockAdvanceStatus;
        if (transport.clockAdvanceStatus === "ready") {
          clock.frozen_time = target;
          clock.status = "ready";
          for (const [subId, item] of subItems) {
            const customer = customerObjects.get(item.customer);
            if (!customer || customer.test_clock !== id) continue;
            const defaultPm = (customer.invoice_settings as { default_payment_method: string | null } | undefined)?.default_payment_method
              ?? item.defaultPaymentMethod;
            seq += 1;
            const invoiceId = `in_clock_${seq}`;
            if (defaultPm === "pm_card_chargeCustomerFail") {
              events.push({
                id: `evt_fail_${seq}`,
                object: "event",
                livemode: false,
                created: target,
                type: "invoice.payment_failed",
                data: {
                  object: {
                    id: invoiceId,
                    object: "invoice",
                    livemode: false,
                    status: "open",
                    paid: false,
                    customer: item.customer,
                    subscription: subId,
                  },
                },
              });
            } else {
              events.push({
                id: `evt_paid_${seq}`,
                object: "event",
                livemode: false,
                created: target,
                type: "invoice.paid",
                data: {
                  object: {
                    id: invoiceId,
                    object: "invoice",
                    livemode: false,
                    status: "paid",
                    paid: true,
                    customer: item.customer,
                    subscription: subId,
                  },
                },
              });
            }
          }
        } else if (transport.clockAdvanceStatus === "advancing") {
          clock.frozen_time = target;
        }
        return { ...clock };
      }
      if (method === "DELETE" && /^test_helpers\/test_clocks\/[^/]+$/.test(path)) {
        const id = path.split("/")[2]!;
        if (transport.failCleanup) {
          throw new J9StripeError({
            status: transport.cleanupFailStatus,
            code: transport.cleanupFailCode,
            stripeType: "api_error",
            message: `stripe_${transport.cleanupFailStatus}:${transport.cleanupFailMessage}`,
          });
        }
        if (deletedClocks.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:test_clock_missing" });
        }
        deletedClocks.add(id);
        deletedTestClocks.push(id);
        return { id, object: "test_helpers.test_clock", deleted: true };
      }
      if (method === "GET" && path === "events") {
        const type = params?.type;
        const data = events.filter((event) => (type ? event.type === type : true));
        return { object: "list", data: data.map((event) => ({ ...event })), has_more: false };
      }
      if (method === "GET" && /^prices\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        return prices.get(id) ?? {
          id,
          object: "price",
          livemode: false,
          recurring: { interval: "month", interval_count: 1 },
        };
      }
      if (method === "POST" && path === "customers") {
        const id = `cus_j9_${seq}`;
        customers.push(id);
        const metadata: Record<string, string> = {
          workspace_id: params?.["metadata[workspace_id]"] ?? "",
          fizot_j9_run_id: params?.["metadata[fizot_j9_run_id]"] ?? "",
        };
        const customer = {
          id,
          object: "customer",
          livemode: false,
          email: params?.email ?? null,
          test_clock: params?.test_clock ?? null,
          invoice_settings: { default_payment_method: null as string | null },
          metadata,
        };
        customerObjects.set(id, customer);
        return { ...customer };
      }
      if (method === "GET" && /^customers\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        const customer = customerObjects.get(id);
        if (!customer || deletedCust.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:customer_missing" });
        }
        return { ...customer };
      }
      if (method === "POST" && /^customers\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        const customer = customerObjects.get(id);
        if (!customer || deletedCust.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:customer_missing" });
        }
        if (params?.["invoice_settings[default_payment_method]"]) {
          (customer.invoice_settings as { default_payment_method: string | null }).default_payment_method =
            params["invoice_settings[default_payment_method]"];
        }
        return { ...customer };
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
          line_price: params?.["line_items[0][price]"] ?? null,
          metadata: {
            workspace_id: params?.["metadata[workspace_id]"] ?? "",
            plan: params?.["metadata[plan]"] ?? "",
            fizot_j9_run_id: params?.["metadata[fizot_j9_run_id]"] ?? "",
          },
        };
        sessions.set(id, session);
        return { ...session };
      }
      if (method === "GET" && /^checkout\/sessions\/[^/]+$/.test(path)) {
        const id = path.split("/")[2]!;
        const session = sessions.get(id);
        if (!session) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:checkout_session_missing" });
        }
        return { ...session };
      }
      if (method === "POST" && /^checkout\/sessions\/[^/]+\/expire$/.test(path)) {
        const id = path.split("/")[2]!;
        if (transport.failCleanup) {
          throw new J9StripeError({
            status: transport.cleanupFailStatus,
            code: transport.cleanupFailCode,
            stripeType: "api_error",
            message: `stripe_${transport.cleanupFailStatus}:${transport.cleanupFailMessage}`,
          });
        }
        const session = sessions.get(id);
        if (!session) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:checkout_session_missing" });
        }
        if (session.status === "expired") {
          throw new J9StripeError({
            status: 400,
            code: "checkout_session_already_expired",
            stripeType: "invalid_request_error",
            message: "stripe_400:checkout_session_already_expired",
          });
        }
        if (session.status === "complete") {
          throw new J9StripeError({
            status: 400,
            code: "checkout_session_unexpected_state",
            stripeType: "invalid_request_error",
            message: "stripe_400:checkout_session_unexpected_state",
          });
        }
        session.status = "expired";
        expiredSessions.push(id);
        return { ...session };
      }
      if (method === "POST" && path === "payment_methods") {
        return { id: `pm_j9_${seq}`, object: "payment_method", type: "card", livemode: false };
      }
      // Official Stripe path: POST /v1/payment_methods/:id/attach
      if (method === "POST" && /^payment_methods\/[^/]+\/attach$/.test(path)) {
        return { id: path.split("/")[1], object: "payment_method", customer: params?.customer ?? null, livemode: false };
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
          fizot_j9_run_id: params?.["metadata[fizot_j9_run_id]"] ?? "",
        };
        prices.set(price, {
          id: price,
          object: "price",
          livemode: false,
          recurring: { interval: "month", interval_count: 1 },
        });
        subscriptions.push(id);
        subItems.set(id, {
          id: itemId,
          price,
          quantity,
          customer,
          metadata,
          defaultPaymentMethod: params?.default_payment_method ?? null,
        });
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
          items: { data: [{ id: itemId, quantity, price: { id: price, recurring: { interval: "month", interval_count: 1 } } }] },
          latest_invoice: expandInvoice ? { ...invoice } : invoiceId,
        };
      }
      if (method === "GET" && /^invoices\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        const invoice = invoices.get(id);
        if (!invoice) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:invoice_missing" });
        }
        return { ...invoice };
      }
      if (method === "POST" && /^subscriptions\/[^/]+$/.test(path) && params?.["items[0][quantity]"]) {
        const id = path.split("/")[1]!;
        if (deletedSubs.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:subscription_missing" });
        }
        const item = subItems.get(id);
        const itemId = params["items[0][id]"];
        if (!item || !itemId || itemId !== item.id) {
          throw new J9StripeError({ status: 400, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_400:subscription_item_mismatch" });
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
        if (deletedSubs.has(id)) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:subscription_missing" });
        }
        const item = subItems.get(id);
        if (!item) {
          throw new J9StripeError({ status: 404, code: "resource_missing", stripeType: "invalid_request_error", message: "stripe_404:subscription_missing" });
        }
        const expandInvoice = params?.["expand[]"] === "latest_invoice";
        let latestInvoice: string | Record<string, unknown> | null = null;
        for (const [invoiceId, invoice] of invoices) {
          if (invoice.subscription === id) {
            latestInvoice = expandInvoice ? { ...invoice } : invoiceId;
          }
        }
        return {
          id,
          object: "subscription",
          livemode: false,
          status: "active",
          customer: item.customer,
          metadata: item.metadata,
          default_payment_method: item.defaultPaymentMethod,
          latest_invoice: latestInvoice,
          items: {
            data: [{
              id: item.id,
              quantity: item.quantity,
              price: { id: item.price, object: "price", livemode: false, recurring: { interval: "month", interval_count: 1 } },
            }],
          },
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
        throw new J9StripeError({
          status: 400,
          code: "parameter_missing",
          stripeType: "invalid_request_error",
          message: "stripe_400:vat_id_required_for_eu_business",
        });
      }
      if (method === "DELETE" && /^subscriptions\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        if (transport.failCleanup) {
          throw new J9StripeError({
            status: transport.cleanupFailStatus,
            code: transport.cleanupFailCode,
            stripeType: "api_error",
            message: `stripe_${transport.cleanupFailStatus}:${transport.cleanupFailMessage}`,
          });
        }
        if (deletedSubs.has(id)) {
          throw new J9StripeError({
            status: 404,
            code: "resource_missing",
            stripeType: "invalid_request_error",
            message: "stripe_404:subscription_already_deleted",
          });
        }
        deletedSubs.add(id);
        deletedSubscriptions.push(id);
        return { id, object: "subscription", status: "canceled" };
      }
      if (method === "DELETE" && /^customers\/[^/]+$/.test(path)) {
        const id = path.split("/")[1]!;
        if (transport.failCleanup) {
          throw new J9StripeError({
            status: transport.cleanupFailStatus,
            code: transport.cleanupFailCode,
            stripeType: "api_error",
            message: `stripe_${transport.cleanupFailStatus}:${transport.cleanupFailMessage}`,
          });
        }
        if (deletedCust.has(id)) {
          throw new J9StripeError({
            status: 404,
            code: "resource_missing",
            stripeType: "invalid_request_error",
            message: "stripe_404:customer_already_deleted",
          });
        }
        deletedCust.add(id);
        deletedCustomers.push(id);
        return { id, object: "customer", deleted: true };
      }
      throw new J9StripeError({
        status: 500,
        code: "fake_unhandled",
        stripeType: "api_error",
        message: `fake_stripe_unhandled:${method}:${path}`,
      });
    },
  };
  return transport;
}
