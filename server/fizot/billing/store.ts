import { emptyRecord, type BillingRecord } from "./record.ts";

export interface BillingStore {
  get(workspaceId: string): Promise<BillingRecord | null>;
  save(record: BillingRecord): Promise<void>;
  findByCustomer(customerId: string): Promise<BillingRecord | null>;
  findBySubscription(subscriptionId: string): Promise<BillingRecord | null>;
  list(): Promise<BillingRecord[]>;
  close(): Promise<void>;
}

export function createMemoryBillingStore(): BillingStore {
  const rows = new Map<string, BillingRecord>();
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => T): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    async get(workspaceId) {
      return lock(() => rows.get(workspaceId) ?? null);
    },
    async save(record) {
      await lock(() => { rows.set(record.workspaceId, { ...record }); });
    },
    async findByCustomer(customerId) {
      return lock(() => [...rows.values()].find((row) => row.stripeCustomerId === customerId) ?? null);
    },
    async findBySubscription(subscriptionId) {
      return lock(() => [...rows.values()].find((row) => row.stripeSubscriptionId === subscriptionId) ?? null);
    },
    async list() {
      return lock(() => [...rows.values()].map((row) => ({ ...row })));
    },
    async close() {},
  };
}

function fromRow(row: Record<string, unknown>): BillingRecord {
  const base = emptyRecord(String(row.workspace_id));
  return {
    ...base,
    stripeCustomerId: row.stripe_customer_id == null ? null : String(row.stripe_customer_id),
    stripeSubscriptionId: row.stripe_subscription_id == null ? null : String(row.stripe_subscription_id),
    stripeItemId: row.stripe_item_id == null ? null : String(row.stripe_item_id),
    status: row.status as BillingRecord["status"],
    objectVersion: Number(row.object_version ?? 0),
    paymentMethod: row.payment_method === true,
    quantity: Number(row.quantity ?? 1),
    priceId: row.price_id == null ? null : String(row.price_id),
    plan: row.plan === "home" || row.plan === "team" ? row.plan : null,
    firstFailureAt: row.first_failure_at == null ? null : new Date(String(row.first_failure_at)).getTime(),
    suspendedAt: row.suspended_at == null ? null : new Date(String(row.suspended_at)).getTime(),
    noticeSentAt: row.notice_sent_at == null ? null : new Date(String(row.notice_sent_at)).getTime(),
    deletionRequestedAt: row.deletion_requested_at == null ? null : new Date(String(row.deletion_requested_at)).getTime(),
    country: row.country == null ? null : String(row.country),
    vatId: row.vat_id == null ? null : String(row.vat_id),
    lastFinalizedInvoiceId: row.last_finalized_invoice_id == null ? null : String(row.last_finalized_invoice_id),
    finalizedVersion: Number(row.finalized_version ?? 0),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fizot_billing_subscriptions (
  workspace_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_item_id TEXT,
  status TEXT NOT NULL,
  object_version BIGINT NOT NULL,
  payment_method BOOLEAN NOT NULL,
  quantity INT NOT NULL,
  price_id TEXT,
  plan TEXT,
  first_failure_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  notice_sent_at TIMESTAMPTZ,
  deletion_requested_at TIMESTAMPTZ,
  country TEXT,
  vat_id TEXT,
  last_finalized_invoice_id TEXT,
  finalized_version BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fizot_billing_customer ON fizot_billing_subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS fizot_billing_subscription ON fizot_billing_subscriptions (stripe_subscription_id);
`;

export async function createPostgresBillingStore(databaseUrl: string): Promise<BillingStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(SCHEMA);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) throw error;
    await pool.query(SCHEMA);
  }
  const ms = (value: number | null) => (value == null ? null : new Date(value).toISOString());
  return {
    async get(workspaceId) {
      const result = await pool.query(`SELECT * FROM fizot_billing_subscriptions WHERE workspace_id = $1`, [workspaceId]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async save(record) {
      await pool.query(
        `INSERT INTO fizot_billing_subscriptions (
           workspace_id, stripe_customer_id, stripe_subscription_id, stripe_item_id, status, object_version,
           payment_method, quantity, price_id, plan, first_failure_at, suspended_at, notice_sent_at,
           deletion_requested_at, country, vat_id, last_finalized_invoice_id, finalized_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (workspace_id) DO UPDATE SET
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_item_id = EXCLUDED.stripe_item_id,
           status = EXCLUDED.status,
           object_version = EXCLUDED.object_version,
           payment_method = EXCLUDED.payment_method,
           quantity = EXCLUDED.quantity,
           price_id = EXCLUDED.price_id,
           plan = EXCLUDED.plan,
           first_failure_at = EXCLUDED.first_failure_at,
           suspended_at = EXCLUDED.suspended_at,
           notice_sent_at = EXCLUDED.notice_sent_at,
           deletion_requested_at = EXCLUDED.deletion_requested_at,
           country = EXCLUDED.country,
           vat_id = EXCLUDED.vat_id,
           last_finalized_invoice_id = EXCLUDED.last_finalized_invoice_id,
           finalized_version = EXCLUDED.finalized_version`,
        [
          record.workspaceId, record.stripeCustomerId, record.stripeSubscriptionId, record.stripeItemId,
          record.status, record.objectVersion, record.paymentMethod, record.quantity, record.priceId, record.plan,
          ms(record.firstFailureAt), ms(record.suspendedAt), ms(record.noticeSentAt), ms(record.deletionRequestedAt),
          record.country, record.vatId, record.lastFinalizedInvoiceId, record.finalizedVersion,
        ],
      );
    },
    async findByCustomer(customerId) {
      const result = await pool.query(
        `SELECT * FROM fizot_billing_subscriptions WHERE stripe_customer_id = $1 LIMIT 1`,
        [customerId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async findBySubscription(subscriptionId) {
      const result = await pool.query(
        `SELECT * FROM fizot_billing_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
        [subscriptionId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    },
    async list() {
      const result = await pool.query(`SELECT * FROM fizot_billing_subscriptions`);
      return result.rows.map((row) => fromRow(row));
    },
    async close() {
      await pool.end();
    },
  };
}
