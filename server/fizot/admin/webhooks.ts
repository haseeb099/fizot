/**
 * Webhook receiver: signature verify + exactly-once delivery (P4.2 / FZ-25).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookProvider = "generic" | "stripe";

export type WebhookEventRecord = {
  provider: string;
  eventId: string;
  receivedAt: string;
};

export interface WebhookEventStore {
  /** Insert; throws with code=webhook_duplicate on unique conflict. */
  insert(provider: string, eventId: string, receivedAt: string): Promise<WebhookEventRecord>;
  has(provider: string, eventId: string): Promise<boolean>;
  /** Run fn inside a transaction when the backend supports it. */
  withTransaction?<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMemoryWebhookEventStore(): WebhookEventStore & {
  rows: Map<string, WebhookEventRecord>;
} {
  const rows = new Map<string, WebhookEventRecord>();
  const key = (provider: string, eventId: string) => `${provider}::${eventId}`;
  return {
    rows,
    async insert(provider, eventId, receivedAt) {
      const k = key(provider, eventId);
      if (rows.has(k)) {
        throw Object.assign(new Error("webhook_duplicate"), { code: "webhook_duplicate", status: 409 });
      }
      const record = { provider, eventId, receivedAt };
      rows.set(k, record);
      return record;
    },
    async has(provider, eventId) {
      return rows.has(key(provider, eventId));
    },
  };
}

export async function createPostgresWebhookEventStore(databaseUrl: string): Promise<WebhookEventStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fizot_admin_webhook_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (provider, event_id)
    );
  `);
  return {
    async insert(provider, eventId, receivedAt) {
      try {
        await pool.query(
          `INSERT INTO fizot_admin_webhook_events (provider, event_id, received_at) VALUES ($1,$2,$3)`,
          [provider, eventId, receivedAt],
        );
        return { provider, eventId, receivedAt };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if (code === "23505") {
          throw Object.assign(new Error("webhook_duplicate"), { code: "webhook_duplicate", status: 409 });
        }
        throw error;
      }
    },
    async has(provider, eventId) {
      const result = await pool.query(
        `SELECT 1 FROM fizot_admin_webhook_events WHERE provider = $1 AND event_id = $2`,
        [provider, eventId],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export const WEBHOOK_MAX_SKEW_SEC = 300;

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function safeEqualUtf8(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Generic HMAC-SHA256 hex of `${timestamp}.${body}` (or body alone when no timestamp). */
export function signGenericHmac(secret: string, body: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyHmacSha256(input: {
  secret: string;
  body: string | Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: () => number;
  maxSkewSec?: number;
}): { ok: true } | { ok: false; error: "invalid_signature" | "stale_request" | "missing_signature" } {
  const now = input.now ?? Date.now;
  const maxSkewSec = input.maxSkewSec ?? WEBHOOK_MAX_SKEW_SEC;
  if (!input.signature || !input.timestamp) return { ok: false, error: "missing_signature" };
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, error: "stale_request" };
  const skew = Math.abs(Math.floor(now() / 1000) - ts);
  if (skew > maxSkewSec) return { ok: false, error: "stale_request" };
  const body = typeof input.body === "string" ? input.body : input.body.toString("utf8");
  const expected = signGenericHmac(input.secret, body, input.timestamp);
  const provided = input.signature.replace(/^sha256=/i, "").trim();
  if (!safeEqualHex(expected, provided) && !safeEqualUtf8(expected, provided)) {
    return { ok: false, error: "invalid_signature" };
  }
  return { ok: true };
}

/** Stripe-style `Stripe-Signature: t=…,v1=…` (HMAC-SHA256 hex of `${t}.${body}`). */
export function signStripeHeader(secret: string, body: string, timestampSec: number): string {
  const t = String(timestampSec);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verifyStripeSignature(input: {
  secret: string;
  body: string | Buffer;
  header: string | undefined;
  now?: () => number;
  maxSkewSec?: number;
}): { ok: true; timestamp: string } | { ok: false; error: "invalid_signature" | "stale_request" | "missing_signature" } {
  const now = input.now ?? Date.now;
  const maxSkewSec = input.maxSkewSec ?? WEBHOOK_MAX_SKEW_SEC;
  if (!input.header) return { ok: false, error: "missing_signature" };
  const parts = Object.fromEntries(
    input.header.split(",").map((p) => {
      const [k, ...rest] = p.trim().split("=");
      return [k ?? "", rest.join("=")];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, error: "missing_signature" };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, error: "stale_request" };
  if (Math.abs(Math.floor(now() / 1000) - ts) > maxSkewSec) return { ok: false, error: "stale_request" };
  const body = typeof input.body === "string" ? input.body : input.body.toString("utf8");
  const expected = createHmac("sha256", input.secret).update(`${t}.${body}`).digest("hex");
  if (!safeEqualHex(expected, v1)) return { ok: false, error: "invalid_signature" };
  return { ok: true, timestamp: t };
}

export async function deliverWebhookEvent<T>(input: {
  store: WebhookEventStore;
  provider: string;
  eventId: string;
  handler: () => Promise<T> | T;
  now?: () => number;
}): Promise<{ delivered: true; result: T } | { delivered: false; reason: "duplicate" }> {
  const now = input.now ?? Date.now;
  const receivedAt = new Date(now()).toISOString();
  const run = async () => {
    try {
      await input.store.insert(input.provider, input.eventId, receivedAt);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "webhook_duplicate") {
        return { delivered: false as const, reason: "duplicate" as const };
      }
      throw error;
    }
    const result = await input.handler();
    return { delivered: true as const, result };
  };
  if (input.store.withTransaction) return input.store.withTransaction(run);
  return run();
}

export function resolveWebhookSecret(provider: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (provider === "stripe") return env.FIZOT_WEBHOOK_STRIPE_SECRET?.trim() || env.STRIPE_WEBHOOK_SECRET?.trim() || null;
  if (provider === "generic") return env.FIZOT_WEBHOOK_GENERIC_SECRET?.trim() || null;
  return env[`FIZOT_WEBHOOK_${provider.toUpperCase()}_SECRET`]?.trim() || null;
}
