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
export async function advanceTestClockUntilReady(options: AdvancePollOptions): Promise<AdvancePollResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 40;
  const sleepMs = options.sleepMs ?? 0;
  await options.transport.request("POST", `test_helpers/test_clocks/${options.clockId}/advance`, {
    frozen_time: String(options.targetFrozenTime),
  });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const retrieved = await retrieveTestClock(options.transport, options.clockId);
    if (!retrieved.ok) return { ok: false, reason: retrieved.reason };
    if (retrieved.clock.status === "internal_failure") {
      return { ok: false, reason: "test_clock_internal_failure", status: "internal_failure" };
    }
    if (retrieved.clock.status === "ready" && retrieved.clock.frozen_time >= options.targetFrozenTime) {
      return { ok: true, clock: retrieved.clock };
    }
    if (retrieved.clock.status !== "ready" && retrieved.clock.status !== "advancing") {
      return { ok: false, reason: `test_clock_status=${retrieved.clock.status}`, status: retrieved.clock.status };
    }
    if (sleepMs > 0) await sleep(sleepMs);
  }
  return { ok: false, reason: "test_clock_advance_timeout" };
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

export function correlateCustomerEvents(
  events: StripeEventLike[],
  expected: { customerId: string; subscriptionId?: string; types: string[] },
): { matched: StripeEventLike[]; missingTypes: string[] } {
  const matched: StripeEventLike[] = [];
  for (const event of events) {
    if (!expected.types.includes(event.type)) continue;
    const obj = event.data.object;
    const customer = typeof obj.customer === "string" ? obj.customer : typeof obj.id === "string" && obj.object === "customer" ? obj.id : null;
    const subscription = typeof obj.subscription === "string"
      ? obj.subscription
      : typeof obj.id === "string" && obj.object === "subscription"
        ? obj.id
        : null;
    if (customer && customer !== expected.customerId) continue;
    if (expected.subscriptionId && subscription && subscription !== expected.subscriptionId) continue;
    if (expected.subscriptionId && event.type.startsWith("invoice.") && subscription !== expected.subscriptionId) continue;
    matched.push(event);
  }
  const present = new Set(matched.map((row) => row.type));
  const missingTypes = expected.types.filter((type) => !present.has(type));
  return { matched, missingTypes };
}
