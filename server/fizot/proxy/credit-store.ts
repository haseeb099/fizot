import { randomUUID } from "node:crypto";

export type LedgerKind = "grant" | "usage" | "refund" | "adjust";

export type CreditLedgerRow = {
  id: string;
  workspaceId: string;
  kind: LedgerKind;
  amountMicroGbp: number;
  requestId: string | null;
  provider: string | null;
  model: string | null;
  tier: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  meta: Record<string, unknown>;
};

export type ReservationStatus = "reserved" | "settled" | "released";

export type CreditReservation = {
  requestId: string;
  workspaceId: string;
  amountMicroGbp: number;
  status: ReservationStatus;
  httpStatus: number | null;
  responseBody: string | null;
  contentType: string | null;
  createdAt: string;
};

export type CreditSummary = {
  balanceMicroGbp: number;
  includedMicroGbp: number;
  periodUsageMicroGbp: number;
  reservedMicroGbp: number;
  period: string;
};

export type ReserveResult =
  | { ok: true; reservation: CreditReservation }
  | { ok: false; reason: "insufficient" }
  | { ok: false; reason: "in_flight"; reservation: CreditReservation }
  | { ok: false; reason: "replay"; reservation: CreditReservation };

const META_FORBIDDEN = new Set([
  "prompt", "content", "messages", "response", "input", "output", "completion", "email",
]);

export function periodKey(now = Date.now()): string {
  const date = new Date(now);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
}

export function cleanLedgerMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (META_FORBIDDEN.has(key)) continue;
    if (typeof value === "string" && value.length > 200) continue;
    out[key] = value;
  }
  return out;
}

function assertInt(name: string, value: number): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
}

export type CreditStore = {
  ensureAccount(workspaceId: string, includedMicroGbp: number): Promise<void>;
  summary(workspaceId: string, now?: number): Promise<CreditSummary>;
  grant(input: {
    workspaceId: string;
    amountMicroGbp: number;
    requestId: string;
    kind?: "grant" | "refund" | "adjust";
    meta?: Record<string, unknown>;
  }): Promise<CreditLedgerRow>;
  tryReserve(input: {
    workspaceId: string;
    requestId: string;
    amountMicroGbp: number;
  }): Promise<ReserveResult>;
  settle(input: {
    requestId: string;
    amountMicroGbp: number;
    provider: string | null;
    model: string | null;
    tier: string | null;
    inputTokens: number;
    outputTokens: number;
    httpStatus: number;
    responseBody: string;
    contentType: string;
    meta?: Record<string, unknown>;
  }): Promise<CreditLedgerRow>;
  release(requestId: string): Promise<void>;
  markAlerted(workspaceId: string, period: string): Promise<boolean>;
  alerted(workspaceId: string, period: string): Promise<boolean>;
  usageCount(workspaceId: string): Promise<number>;
  settledMicroGbp(workspaceId: string): Promise<number>;
  tryMutateLedger(): Promise<"rejected">;
  disabled(): Promise<boolean>;
  setDisabled(disabled: boolean): Promise<void>;
  close(): Promise<void>;
};

type MemoryState = {
  included: Map<string, number>;
  ledger: CreditLedgerRow[];
  reservations: Map<string, CreditReservation>;
  alerts: Set<string>;
  disabled: boolean;
};

export function createMemoryCreditStore(): CreditStore {
  const state: MemoryState = {
    included: new Map(),
    ledger: [],
    reservations: new Map(),
    alerts: new Set(),
    disabled: false,
  };
  let tail: Promise<void> = Promise.resolve();
  function lock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }
  function balanceOf(workspaceId: string): number {
    return state.ledger.filter((row) => row.workspaceId === workspaceId)
      .reduce((sum, row) => sum + row.amountMicroGbp, 0);
  }
  function reservedOf(workspaceId: string): number {
    let sum = 0;
    for (const row of state.reservations.values()) {
      if (row.workspaceId === workspaceId && row.status === "reserved") sum += row.amountMicroGbp;
    }
    return sum;
  }

  return {
    async ensureAccount(workspaceId, includedMicroGbp) {
      assertInt("includedMicroGbp", includedMicroGbp);
      await lock(() => {
        if (!state.included.has(workspaceId)) state.included.set(workspaceId, includedMicroGbp);
      });
    },
    async summary(workspaceId, now = Date.now()) {
      return lock(() => {
        const period = periodKey(now);
        const periodUsageMicroGbp = state.ledger
          .filter((row) => row.workspaceId === workspaceId && row.kind === "usage" && row.createdAt.startsWith(period))
          .reduce((sum, row) => sum + -row.amountMicroGbp, 0);
        return {
          balanceMicroGbp: balanceOf(workspaceId),
          includedMicroGbp: state.included.get(workspaceId) ?? 0,
          periodUsageMicroGbp,
          reservedMicroGbp: reservedOf(workspaceId),
          period,
        };
      });
    },
    async grant(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      return lock(() => {
        const existing = state.ledger.find((row) => row.requestId === input.requestId);
        if (existing) return existing;
        const row: CreditLedgerRow = {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          kind: input.kind ?? "grant",
          amountMicroGbp: input.amountMicroGbp,
          requestId: input.requestId,
          provider: null,
          model: null,
          tier: null,
          inputTokens: null,
          outputTokens: null,
          createdAt: new Date().toISOString(),
          meta: cleanLedgerMeta(input.meta),
        };
        state.ledger.push(row);
        return row;
      });
    },
    async tryReserve(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      if (input.amountMicroGbp < 0) throw new Error("reserve must be non-negative");
      return lock(() => {
        const existing = state.reservations.get(input.requestId);
        if (existing?.status === "settled") return { ok: false as const, reason: "replay" as const, reservation: existing };
        if (existing?.status === "reserved") return { ok: false as const, reason: "in_flight" as const, reservation: existing };
        const available = balanceOf(input.workspaceId) - reservedOf(input.workspaceId);
        if (available < input.amountMicroGbp) return { ok: false as const, reason: "insufficient" as const };
        const reservation: CreditReservation = {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          amountMicroGbp: input.amountMicroGbp,
          status: "reserved",
          httpStatus: null,
          responseBody: null,
          contentType: null,
          createdAt: new Date().toISOString(),
        };
        state.reservations.set(input.requestId, reservation);
        return { ok: true as const, reservation };
      });
    },
    async settle(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      assertInt("inputTokens", input.inputTokens);
      assertInt("outputTokens", input.outputTokens);
      return lock(() => {
        const reservation = state.reservations.get(input.requestId);
        if (!reservation) throw new Error("reservation missing");
        const existing = state.ledger.find((row) => row.requestId === input.requestId);
        if (existing) return existing;
        const row: CreditLedgerRow = {
          id: randomUUID(),
          workspaceId: reservation.workspaceId,
          kind: "usage",
          amountMicroGbp: -Math.abs(input.amountMicroGbp),
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          tier: input.tier,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          createdAt: new Date().toISOString(),
          meta: cleanLedgerMeta(input.meta),
        };
        state.ledger.push(row);
        state.reservations.set(input.requestId, {
          ...reservation,
          status: "settled",
          httpStatus: input.httpStatus,
          responseBody: input.responseBody,
          contentType: input.contentType,
        });
        return row;
      });
    },
    async release(requestId) {
      await lock(() => {
        const reservation = state.reservations.get(requestId);
        if (!reservation || reservation.status !== "reserved") return;
        state.reservations.set(requestId, { ...reservation, status: "released" });
      });
    },
    async markAlerted(workspaceId, period) {
      return lock(() => {
        const key = `${workspaceId}\0${period}`;
        if (state.alerts.has(key)) return false;
        state.alerts.add(key);
        return true;
      });
    },
    async alerted(workspaceId, period) {
      return state.alerts.has(`${workspaceId}\0${period}`);
    },
    async usageCount(workspaceId) {
      return state.ledger.filter((row) => row.workspaceId === workspaceId && row.kind === "usage").length;
    },
    async settledMicroGbp(workspaceId) {
      return state.ledger
        .filter((row) => row.workspaceId === workspaceId && row.kind === "usage")
        .reduce((sum, row) => sum + -row.amountMicroGbp, 0);
    },
    async tryMutateLedger() {
      return lock(() => {
        if (state.ledger.length === 0) throw new Error("credit_ledger is append-only");
        return "rejected" as const;
      });
    },
    async disabled() {
      return state.disabled;
    },
    async setDisabled(disabled) {
      state.disabled = disabled;
    },
    async close() {},
  };
}

type PgPool = {
  connect(): Promise<PgClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end(): Promise<void>;
};
type PgClient = PgPool & { release(): void };

function num(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value ?? 0);
  if (!Number.isInteger(parsed)) throw new Error("non-integer money from postgres");
  return parsed;
}

function mapLedger(row: Record<string, unknown>): CreditLedgerRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: row.kind as LedgerKind,
    amountMicroGbp: num(row.amount_micro_gbp),
    requestId: row.request_id == null ? null : String(row.request_id),
    provider: row.provider == null ? null : String(row.provider),
    model: row.model == null ? null : String(row.model),
    tier: row.tier == null ? null : String(row.tier),
    inputTokens: row.input_tokens == null ? null : num(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : num(row.output_tokens),
    createdAt: new Date(String(row.created_at)).toISOString(),
    meta: (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<string, unknown>,
  };
}

function mapReservation(row: Record<string, unknown>): CreditReservation {
  return {
    requestId: String(row.request_id),
    workspaceId: String(row.workspace_id),
    amountMicroGbp: num(row.amount_micro_gbp),
    status: row.status as ReservationStatus,
    httpStatus: row.http_status == null ? null : num(row.http_status),
    responseBody: row.response_body == null ? null : String(row.response_body),
    contentType: row.content_type == null ? null : String(row.content_type),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fizot_credit_accounts (
  workspace_id TEXT PRIMARY KEY,
  included_micro_gbp BIGINT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS fizot_credit_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('grant','usage','refund','adjust')),
  amount_micro_gbp BIGINT NOT NULL,
  request_id TEXT UNIQUE,
  provider TEXT,
  model TEXT,
  tier TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS fizot_credit_reservations (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  amount_micro_gbp BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')),
  http_status INTEGER,
  response_body TEXT,
  content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS fizot_credit_alerts (
  workspace_id TEXT NOT NULL,
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, period, kind)
);
CREATE TABLE IF NOT EXISTS fizot_proxy_control (
  id TEXT PRIMARY KEY,
  disabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO fizot_proxy_control (id, disabled)
VALUES ('global', FALSE)
ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION fizot_credit_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS fizot_credit_ledger_no_mutate ON fizot_credit_ledger;
CREATE TRIGGER fizot_credit_ledger_no_mutate
BEFORE UPDATE OR DELETE ON fizot_credit_ledger
FOR EACH ROW EXECUTE FUNCTION fizot_credit_ledger_immutable();
REVOKE UPDATE, DELETE ON fizot_credit_ledger FROM PUBLIC;
`;

export async function createPostgresCreditStore(databaseUrl: string): Promise<CreditStore> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl }) as unknown as PgPool;
  try {
    await pool.query(SCHEMA);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already exists")) throw error;
    await pool.query(SCHEMA);
  }

  async function withLock<T>(workspaceId: string, fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [workspaceId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async ensureAccount(workspaceId, includedMicroGbp) {
      assertInt("includedMicroGbp", includedMicroGbp);
      await pool.query(
        `INSERT INTO fizot_credit_accounts (workspace_id, included_micro_gbp)
         VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId, includedMicroGbp],
      );
    },
    async summary(workspaceId, now = Date.now()) {
      const period = periodKey(now);
      const result = await pool.query(
        `SELECT
           (SELECT included_micro_gbp FROM fizot_credit_accounts WHERE workspace_id = $1) AS included,
           (SELECT COALESCE(SUM(amount_micro_gbp), 0) FROM fizot_credit_ledger WHERE workspace_id = $1) AS balance,
           (SELECT COALESCE(SUM(-amount_micro_gbp), 0) FROM fizot_credit_ledger
             WHERE workspace_id = $1 AND kind = 'usage' AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2) AS usage,
           (SELECT COALESCE(SUM(amount_micro_gbp), 0) FROM fizot_credit_reservations
             WHERE workspace_id = $1 AND status = 'reserved') AS reserved`,
        [workspaceId, period],
      );
      const row = result.rows[0] ?? {};
      return {
        balanceMicroGbp: num(row.balance),
        includedMicroGbp: row.included == null ? 0 : num(row.included),
        periodUsageMicroGbp: num(row.usage),
        reservedMicroGbp: num(row.reserved),
        period,
      };
    },
    async grant(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      const id = randomUUID();
      const meta = cleanLedgerMeta(input.meta);
      const inserted = await pool.query(
        `INSERT INTO fizot_credit_ledger
          (id, workspace_id, kind, amount_micro_gbp, request_id, meta)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING *`,
        [id, input.workspaceId, input.kind ?? "grant", input.amountMicroGbp, input.requestId, JSON.stringify(meta)],
      );
      if (inserted.rows[0]) return mapLedger(inserted.rows[0]);
      const existing = await pool.query(`SELECT * FROM fizot_credit_ledger WHERE request_id = $1`, [input.requestId]);
      if (!existing.rows[0]) throw new Error("grant missing after conflict");
      return mapLedger(existing.rows[0]);
    },
    async tryReserve(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      return withLock(input.workspaceId, async (client) => {
        const existing = await client.query(
          `SELECT * FROM fizot_credit_reservations WHERE request_id = $1`,
          [input.requestId],
        );
        const prior = existing.rows[0] ? mapReservation(existing.rows[0]) : null;
        if (prior?.status === "settled") return { ok: false as const, reason: "replay" as const, reservation: prior };
        if (prior?.status === "reserved") return { ok: false as const, reason: "in_flight" as const, reservation: prior };
        const sums = await client.query(
          `SELECT
             (SELECT COALESCE(SUM(amount_micro_gbp), 0) FROM fizot_credit_ledger WHERE workspace_id = $1) AS balance,
             (SELECT COALESCE(SUM(amount_micro_gbp), 0) FROM fizot_credit_reservations
               WHERE workspace_id = $1 AND status = 'reserved') AS reserved`,
          [input.workspaceId],
        );
        const available = num(sums.rows[0]?.balance) - num(sums.rows[0]?.reserved);
        if (available < input.amountMicroGbp) return { ok: false as const, reason: "insufficient" as const };
        const inserted = prior
          ? await client.query(
            `UPDATE fizot_credit_reservations
               SET status = 'reserved', amount_micro_gbp = $2, http_status = NULL, response_body = NULL, content_type = NULL
             WHERE request_id = $1 RETURNING *`,
            [input.requestId, input.amountMicroGbp],
          )
          : await client.query(
            `INSERT INTO fizot_credit_reservations (request_id, workspace_id, amount_micro_gbp, status)
             VALUES ($1, $2, $3, 'reserved') RETURNING *`,
            [input.requestId, input.workspaceId, input.amountMicroGbp],
          );
        return { ok: true as const, reservation: mapReservation(inserted.rows[0]!) };
      });
    },
    async settle(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      const reservationRow = await pool.query(
        `SELECT workspace_id FROM fizot_credit_reservations WHERE request_id = $1`,
        [input.requestId],
      );
      const workspaceId = reservationRow.rows[0] ? String(reservationRow.rows[0].workspace_id) : "";
      if (!workspaceId) throw new Error("reservation missing");
      return withLock(workspaceId, async (client) => {
        const existing = await client.query(`SELECT * FROM fizot_credit_ledger WHERE request_id = $1`, [input.requestId]);
        if (existing.rows[0]) return mapLedger(existing.rows[0]);
        const id = randomUUID();
        const inserted = await client.query(
          `INSERT INTO fizot_credit_ledger
            (id, workspace_id, kind, amount_micro_gbp, request_id, provider, model, tier, input_tokens, output_tokens, meta)
           VALUES ($1, $2, 'usage', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           RETURNING *`,
          [
            id,
            workspaceId,
            -Math.abs(input.amountMicroGbp),
            input.requestId,
            input.provider,
            input.model,
            input.tier,
            input.inputTokens,
            input.outputTokens,
            JSON.stringify(cleanLedgerMeta(input.meta)),
          ],
        );
        await client.query(
          `UPDATE fizot_credit_reservations
             SET status = 'settled', http_status = $2, response_body = $3, content_type = $4
           WHERE request_id = $1`,
          [input.requestId, input.httpStatus, input.responseBody, input.contentType],
        );
        return mapLedger(inserted.rows[0]!);
      });
    },
    async release(requestId) {
      await pool.query(
        `UPDATE fizot_credit_reservations SET status = 'released'
         WHERE request_id = $1 AND status = 'reserved'`,
        [requestId],
      );
    },
    async markAlerted(workspaceId, period) {
      const result = await pool.query(
        `INSERT INTO fizot_credit_alerts (workspace_id, period, kind)
         VALUES ($1, $2, 'soft_80')
         ON CONFLICT DO NOTHING
         RETURNING workspace_id`,
        [workspaceId, period],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async alerted(workspaceId, period) {
      const result = await pool.query(
        `SELECT 1 FROM fizot_credit_alerts WHERE workspace_id = $1 AND period = $2 AND kind = 'soft_80'`,
        [workspaceId, period],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async usageCount(workspaceId) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS n FROM fizot_credit_ledger WHERE workspace_id = $1 AND kind = 'usage'`,
        [workspaceId],
      );
      return num(result.rows[0]?.n);
    },
    async settledMicroGbp(workspaceId) {
      const result = await pool.query(
        `SELECT COALESCE(SUM(-amount_micro_gbp), 0) AS n FROM fizot_credit_ledger
         WHERE workspace_id = $1 AND kind = 'usage'`,
        [workspaceId],
      );
      return num(result.rows[0]?.n);
    },
    async tryMutateLedger() {
      const sample = await pool.query(`SELECT id FROM fizot_credit_ledger LIMIT 1`);
      const id = sample.rows[0]?.id;
      if (!id) throw new Error("credit_ledger is append-only");
      const refused = async (sql: string) => {
        try {
          await pool.query(sql, [id]);
          return false;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("append-only")) return true;
          throw error;
        }
      };
      const updateRejected = await refused(`UPDATE fizot_credit_ledger SET meta = meta WHERE id = $1`);
      const deleteRejected = await refused(`DELETE FROM fizot_credit_ledger WHERE id = $1`);
      if (updateRejected && deleteRejected) return "rejected";
      throw new Error("ledger mutation was allowed");
    },
    async disabled() {
      const result = await pool.query(`SELECT disabled FROM fizot_proxy_control WHERE id = 'global'`);
      return result.rows[0]?.disabled === true;
    },
    async setDisabled(disabled) {
      await pool.query(
        `INSERT INTO fizot_proxy_control (id, disabled, updated_at)
         VALUES ('global', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET disabled = EXCLUDED.disabled, updated_at = NOW()`,
        [disabled],
      );
    },
    async close() {
      await pool.end();
    },
  };
}
