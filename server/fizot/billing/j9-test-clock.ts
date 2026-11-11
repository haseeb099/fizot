/**
 * Stripe Test Clock helpers for J9. Distinguishes Stripe frozen_time from the
 * Fizot application worker clock. Unsupported Stripe cases stay BLOCKED.
 */
import type { J9StripeTransport } from "./j9-transport.ts";

export type TestClockObject = {
  id: string;
  object: "test_helpers.test_clock";
  livemode: false;
  status: "ready" | "advancing" | "internal_failure" | string;
  frozen_time: number;
};

export type AdvancePollOptions = {
  transport: J9StripeTransport;
  clockId: string;
  targetFrozenTime: number;
  /** Fake/unit: skip wall-clock sleeps. Live: short poll interval. */
  sleepMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type AdvancePollResult =
  | { ok: true; clock: TestClockObject }
  | { ok: false; reason: string; status?: string };

function requireClock(raw: Record<string, unknown>): TestClockObject | null {
  const id = typeof raw.id === "string" && raw.id.startsWith("clock_") ? raw.id : null;
  if (!id) return null;
  if (raw.object !== "test_helpers.test_clock") return null;
  if (raw.livemode !== false) return null;
  if (typeof raw.frozen_time !== "number") return null;
  if (typeof raw.status !== "string") return null;
  return {
    id,
    object: "test_helpers.test_clock",
    livemode: false,
    status: raw.status,
    frozen_time: raw.frozen_time,
  };
}

export async function createTestClock(
  transport: J9StripeTransport,
  input: { frozenTime: number; name: string },
): Promise<{ ok: true; clock: TestClockObject } | { ok: false; reason: string }> {
  const raw = await transport.request("POST", "test_helpers/test_clocks", {
    frozen_time: String(input.frozenTime),
    name: input.name.slice(0, 300),
  });
  const clock = requireClock(raw);
  if (!clock) return { ok: false, reason: "test_clock_create_invalid" };
  if (clock.status !== "ready") return { ok: false, reason: `test_clock_status=${clock.status}` };
  return { ok: true, clock };
}

export async function retrieveTestClock(
  transport: J9StripeTransport,
  clockId: string,
): Promise<{ ok: true; clock: TestClockObject } | { ok: false; reason: string }> {
  const raw = await transport.request("GET", `test_helpers/test_clocks/${clockId}`, null);
  const clock = requireClock(raw);
  if (!clock) return { ok: false, reason: "test_clock_retrieve_invalid" };
  return { ok: true, clock };
}

/**
 * Advance then poll until status is ready (Stripe docs). internal_failure and
 * timeouts are BLOCKED/FAIL inputs for the caller — never treated as success.
 */
export type EnsureClockResult =
  | { ok: true; clock: TestClockObject; skippedAdvance: boolean }
  | { ok: false; reason: string; status?: string };

/**
 * Bring a Test Clock to target frozen_time without repeating Stripe advances.
 * If frozen_time is already >= target, only polls for ready — never POSTs advance.
 */
export async function ensureTestClockFrozenAt(options: AdvancePollOptions): Promise<EnsureClockResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 40;
  const sleepMs = options.sleepMs ?? 0;

  const initial = await retrieveTestClock(options.transport, options.clockId);
  if (!initial.ok) return { ok: false, reason: initial.reason };
  if (initial.clock.status === "internal_failure") {
    return { ok: false, reason: "test_clock_internal_failure", status: "internal_failure" };
  }

  let skippedAdvance = false;
  if (initial.clock.frozen_time >= options.targetFrozenTime) {
    skippedAdvance = true;
  } else if (initial.clock.status === "advancing") {
    // A prior advance is in flight — poll only; do not POST another advance.
    skippedAdvance = true;
  } else if (initial.clock.status === "ready") {
    await options.transport.request("POST", `test_helpers/test_clocks/${options.clockId}/advance`, {
      frozen_time: String(options.targetFrozenTime),
    });
  } else {
    return { ok: false, reason: `test_clock_status=${initial.clock.status}`, status: initial.clock.status };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const retrieved = await retrieveTestClock(options.transport, options.clockId);
    if (!retrieved.ok) return { ok: false, reason: retrieved.reason };
    if (retrieved.clock.status === "internal_failure") {
      return { ok: false, reason: "test_clock_internal_failure", status: "internal_failure" };
    }
    if (retrieved.clock.status === "ready" && retrieved.clock.frozen_time >= options.targetFrozenTime) {
      return { ok: true, clock: retrieved.clock, skippedAdvance };
    }
    if (retrieved.clock.status !== "ready" && retrieved.clock.status !== "advancing") {
      return { ok: false, reason: `test_clock_status=${retrieved.clock.status}`, status: retrieved.clock.status };
    }
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return { ok: false, reason: "test_clock_advance_timeout" };
}

export async function advanceTestClockUntilReady(options: AdvancePollOptions): Promise<AdvancePollResult> {
  const ensured = await ensureTestClockFrozenAt(options);
  if (!ensured.ok) return { ok: false, reason: ensured.reason, status: ensured.status };
  return { ok: true, clock: ensured.clock };
}

export type RecurringInterval = { interval: "day" | "week" | "month" | "year"; intervalCount: number };

export function recurringIntervalFromPrice(price: Record<string, unknown>): RecurringInterval | null {
  const recurring = price.recurring as { interval?: unknown; interval_count?: unknown } | null | undefined;
  if (!recurring || typeof recurring !== "object") return null;
  const interval = recurring.interval;
  if (interval !== "day" && interval !== "week" && interval !== "month" && interval !== "year") return null;
  const intervalCount = typeof recurring.interval_count === "number" && recurring.interval_count > 0
    ? recurring.interval_count
    : 1;
  return { interval, intervalCount };
}

/** Conservative advance target: one billing period + one hour for draft→finalize. */
export function nextBillingFrozenTime(frozenTime: number, recurring: RecurringInterval): number {
  const hour = 3600;
  switch (recurring.interval) {
    case "day":
      return frozenTime + recurring.intervalCount * 86400 + hour;
    case "week":
      return frozenTime + recurring.intervalCount * 7 * 86400 + hour;
    case "month":
      return frozenTime + recurring.intervalCount * 32 * 86400 + hour;
    case "year":
      return frozenTime + recurring.intervalCount * 366 * 86400 + hour;
    default:
      return frozenTime + 32 * 86400 + hour;
  }
}

export type StripeEventLike = {
  id: string;
  type: string;
  livemode: false;
  created: number;
  data: { object: Record<string, unknown> };
};

export function parseStripeEvent(raw: Record<string, unknown>): StripeEventLike | null {
  if (raw.object !== "event") return null;
  if (raw.livemode !== false) return null;
  if (typeof raw.id !== "string" || !raw.id.startsWith("evt_")) return null;
  if (typeof raw.type !== "string") return null;
  if (typeof raw.created !== "number") return null;
  const data = raw.data as { object?: unknown } | undefined;
  if (!data || typeof data.object !== "object" || data.object == null || Array.isArray(data.object)) return null;
  return {
    id: raw.id,
    type: raw.type,
    livemode: false,
    created: raw.created,
    data: { object: data.object as Record<string, unknown> },
  };
}

export function eventObjectCustomerId(obj: Record<string, unknown>): string | null {
  if (typeof obj.customer === "string" && obj.customer.startsWith("cus_")) return obj.customer;
  if (typeof obj.id === "string" && obj.object === "customer" && obj.id.startsWith("cus_")) return obj.id;
  return null;
}

export function eventObjectSubscriptionId(obj: Record<string, unknown>): string | null {
  if (typeof obj.subscription === "string" && obj.subscription.startsWith("sub_")) return obj.subscription;
  if (typeof obj.id === "string" && obj.object === "subscription" && obj.id.startsWith("sub_")) return obj.id;
  return null;
}

export function eventObjectInvoiceId(obj: Record<string, unknown>): string | null {
  if (typeof obj.id === "string" && obj.object === "invoice" && obj.id.startsWith("in_")) return obj.id;
  return null;
}

/**
 * Correlate Stripe Events to an exact customer/subscription. Missing associations
 * are rejected (never treated as wildcards). Baseline event/invoice ids are excluded.
 */
export function correlateCustomerEvents(
  events: StripeEventLike[],
  expected: {
    customerId: string;
    subscriptionId: string;
    types: string[];
    excludeEventIds?: string[];
    excludeInvoiceIds?: string[];
    createdAfterSec?: number;
  },
): { matched: StripeEventLike[]; missingTypes: string[]; rejected: string[] } {
  const matched: StripeEventLike[] = [];
  const rejected: string[] = [];
  const excludeEvents = new Set(expected.excludeEventIds ?? []);
  const excludeInvoices = new Set(expected.excludeInvoiceIds ?? []);
  for (const event of events) {
    if (!expected.types.includes(event.type)) continue;
    if (excludeEvents.has(event.id)) {
      rejected.push(`${event.id}:baseline_event`);
      continue;
    }
    if (expected.createdAfterSec != null && event.created <= expected.createdAfterSec) {
      rejected.push(`${event.id}:not_after_failure`);
      continue;
    }
    const obj = event.data.object;
    const customer = eventObjectCustomerId(obj);
    const subscription = eventObjectSubscriptionId(obj);
    const invoiceId = eventObjectInvoiceId(obj);
    if (!customer || !subscription) {
      rejected.push(`${event.id}:missing_association`);
      continue;
    }
    if (customer !== expected.customerId || subscription !== expected.subscriptionId) {
      rejected.push(`${event.id}:foreign_resource`);
      continue;
    }
    if (invoiceId && excludeInvoices.has(invoiceId)) {
      rejected.push(`${event.id}:baseline_invoice`);
      continue;
    }
    matched.push(event);
  }
  const present = new Set(matched.map((row) => row.type));
  const missingTypes = expected.types.filter((type) => !present.has(type));
  return { matched, missingTypes, rejected };
}

/** List events with pagination until exhausted or a hard page cap (honest limit). */
export async function listStripeEventsPaged(input: {
  transport: J9StripeTransport;
  type: string;
  maxPages?: number;
}): Promise<{ ok: true; events: StripeEventLike[]; truncated: boolean } | { ok: false; reason: string }> {
  const maxPages = input.maxPages ?? 5;
  const events: StripeEventLike[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const params: Record<string, string> = { type: input.type, limit: "100" };
    if (startingAfter) params.starting_after = startingAfter;
    let raw: Record<string, unknown>;
    try {
      raw = await input.transport.request("GET", "events", params);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : "events_list_failed" };
    }
    const data = (raw.data as Array<Record<string, unknown>> | undefined) ?? [];
    for (const row of data) {
      const parsed = parseStripeEvent(row);
      if (parsed) events.push(parsed);
    }
    const hasMore = raw.has_more === true;
    if (!hasMore || data.length === 0) {
      return { ok: true, events, truncated: false };
    }
    const lastId = data[data.length - 1]?.id;
    if (typeof lastId !== "string") return { ok: true, events, truncated: true };
    startingAfter = lastId;
  }
  return { ok: true, events, truncated: true };
}
