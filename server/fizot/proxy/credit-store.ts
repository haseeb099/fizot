import { randomUUID } from "node:crypto";
import {
  assertLedgerAmount,
  defaultGrantExpiresAtMs,
  expiredGrantResiduals,
  parseFundingSlices,
  planFundingSlices,
  RESERVATION_RECOVERY_GRACE_MS,
  settleFundingSlices,
  spendableMicroGbp,
  type CreditLotSource,
  type FundingSlice,
  type OpenHold,
} from "./credit-policy.ts";

export type LedgerKind = "grant" | "usage" | "refund" | "adjust" | "expire";

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
  /** ISO timestamp; null = legacy grandfathered positive credit (not auto-expired). */
  expiresAt: string | null;
  meta: Record<string, unknown>;
};

/**
 * reserved — held, provider not contacted yet
 * dispatched — provider request sent
 * uncertain — timeout after dispatch; provider may still bill
 * quarantined — past grace; funds held pending reconcile; no fabricated usage
 * settled / released — terminal
 */
export type ReservationStatus =
  | "reserved"
  | "dispatched"
  | "uncertain"
  | "quarantined"
  | "settled"
  | "released";

const HOLDING_STATUSES: readonly ReservationStatus[] = [
  "reserved", "dispatched", "uncertain", "quarantined",
];

function isHolding(status: ReservationStatus): boolean {
  return HOLDING_STATUSES.includes(status);
}

export type CreditReservation = {
  requestId: string;
  workspaceId: string;
  amountMicroGbp: number;
  status: ReservationStatus;
  /** Keyed digest of the workspace, tier, and raw request. */
  requestFingerprint: string | null;
  httpStatus: number | null;
  /** FIFO grant slices bound when the reservation was authorized. */
  funding: FundingSlice[];
  createdAt: string;
  updatedAt: string;
};

export type DispatchResult =
  | { ok: true; reservation: CreditReservation }
  | { ok: false; reason: "not_reserved" | "ownership_mismatch" };

export type RecoverStaleResult = {
  /** Undelivered `reserved` rows released (never dispatched). */
  released: number;
  /** Ambiguous dispatched/uncertain rows moved to quarantined (no usage debit). */
  quarantined: number;
  releasedRequestIds: string[];
  quarantinedRequestIds: string[];
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
  | { ok: false; reason: "replay"; reservation: CreditReservation }
  | { ok: false; reason: "conflict" };

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
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
}

function assertFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_request_fingerprint");
}

function assertGrantInput(kind: "grant" | "refund" | "adjust", amountMicroGbp: number): void {
  assertLedgerAmount(kind, amountMicroGbp);
}

export type CreditStore = {
  ensureAccount(workspaceId: string, includedMicroGbp: number): Promise<void>;
  /** Replace the 80% denominator. Does not write a ledger row. */
  setIncluded(workspaceId: string, includedMicroGbp: number): Promise<void>;
  summary(workspaceId: string, now?: number): Promise<CreditSummary>;
  grant(input: {
    workspaceId: string;
    amountMicroGbp: number;
    requestId: string;
    kind?: "grant" | "refund" | "adjust";
    /** Override grant clock; tests only. */
    nowMs?: number;
    /** When false, leave expires_at null (legacy / operator-approved). Default true for grant/refund/+adjust. */
    expireInTwelveMonths?: boolean;
    meta?: Record<string, unknown>;
  }): Promise<CreditLedgerRow>;
  tryReserve(input: {
    workspaceId: string;
    requestId: string;
    amountMicroGbp: number;
    requestFingerprint: string;
    nowMs?: number;
  }): Promise<ReserveResult>;
  /** Atomic reserved→dispatched. Forward only when ok. */
  markDispatched(workspaceId: string, requestId: string, nowMs?: number): Promise<DispatchResult>;
  settle(input: {
    workspaceId: string;
    requestId: string;
    amountMicroGbp: number;
    provider: string | null;
    model: string | null;
    tier: string | null;
    inputTokens: number;
    outputTokens: number;
    httpStatus: number;
    nowMs?: number;
    meta?: Record<string, unknown>;
  }): Promise<CreditLedgerRow>;
  release(workspaceId: string, requestId: string, nowMs?: number): Promise<void>;
  markUncertain(workspaceId: string, requestId: string, nowMs?: number): Promise<void>;
  /**
   * Recovery: stale undelivered `reserved` → release;
   * stale `dispatched`/`uncertain` → quarantine (hold, no fabricated usage).
   */
  recoverStaleReservations(input?: {
    workspaceId?: string;
    nowMs?: number;
    graceMs?: number;
  }): Promise<RecoverStaleResult>;
  expireDue(workspaceId: string, nowMs?: number): Promise<number>;
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
  function reservedOf(workspaceId: string): number {
    let sum = 0;
    for (const row of state.reservations.values()) {
      if (row.workspaceId === workspaceId && isHolding(row.status)) {
        sum += row.amountMicroGbp;
      }
    }
    return sum;
  }
  function lotsOf(workspaceId: string): CreditLotSource[] {
    return state.ledger
      .filter((row) => row.workspaceId === workspaceId)
      .map((row) => {
        const fundingAuthorizedAtMs = row.kind === "usage" && typeof row.meta.fundingAuthorizedAtMs === "number"
          ? row.meta.fundingAuthorizedAtMs
          : null;
        const funding = row.kind === "usage" && row.meta.funding != null
          ? parseFundingSlices(row.meta.funding)
          : null;
        return {
          id: row.id,
          kind: row.kind,
          amountMicroGbp: row.amountMicroGbp,
          createdAtMs: Date.parse(row.createdAt),
          expiresAtMs: row.expiresAt == null ? null : Date.parse(row.expiresAt),
          requestId: row.requestId,
          fundingAuthorizedAtMs,
          funding,
        };
      });
  }
  function openHoldsOf(workspaceId: string): OpenHold[] {
    const holds: OpenHold[] = [];
    for (const row of state.reservations.values()) {
      if (row.workspaceId !== workspaceId || !isHolding(row.status)) continue;
      holds.push({
        authorizedAtMs: Date.parse(row.createdAt),
        funding: row.funding,
      });
    }
    return holds;
  }
  function expireDueLocked(workspaceId: string, nowMs: number): number {
    const due = expiredGrantResiduals(lotsOf(workspaceId), nowMs, openHoldsOf(workspaceId));
    let wrote = 0;
    for (const item of due) {
      const expireRequestId = `expire:${item.grantId}`;
      if (state.ledger.some((row) => row.requestId === expireRequestId)) continue;
      state.ledger.push({
        id: randomUUID(),
        workspaceId,
        kind: "expire",
        amountMicroGbp: -item.residualMicroGbp,
        requestId: expireRequestId,
        provider: null,
        model: null,
        tier: null,
        inputTokens: null,
        outputTokens: null,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: null,
        meta: cleanLedgerMeta({ grantId: item.grantId, grantRequestId: item.grantRequestId }),
      });
      wrote += 1;
    }
    return wrote;
  }

  return {
    async ensureAccount(workspaceId, includedMicroGbp) {
      assertInt("includedMicroGbp", includedMicroGbp);
      await lock(() => {
        if (!state.included.has(workspaceId)) state.included.set(workspaceId, includedMicroGbp);
      });
    },
    async setIncluded(workspaceId, includedMicroGbp) {
      assertInt("includedMicroGbp", includedMicroGbp);
      await lock(() => {
        state.included.set(workspaceId, includedMicroGbp);
      });
    },
    async summary(workspaceId, now = Date.now()) {
      return lock(() => {
        expireDueLocked(workspaceId, now);
        const period = periodKey(now);
        const periodUsageMicroGbp = state.ledger
          .filter((row) => row.workspaceId === workspaceId && row.kind === "usage" && row.createdAt.startsWith(period))
          .reduce((sum, row) => sum + -row.amountMicroGbp, 0);
        const spendable = spendableMicroGbp(lotsOf(workspaceId), now);
        return {
          balanceMicroGbp: spendable,
          includedMicroGbp: state.included.get(workspaceId) ?? 0,
          periodUsageMicroGbp,
          reservedMicroGbp: reservedOf(workspaceId),
          period,
        };
      });
    },
    async grant(input) {
      const kind = input.kind ?? "grant";
      assertGrantInput(kind, input.amountMicroGbp);
      return lock(() => {
        const existing = state.ledger.find((row) => row.requestId === input.requestId);
        if (existing) {
          if (existing.workspaceId !== input.workspaceId || existing.kind !== kind
            || existing.amountMicroGbp !== input.amountMicroGbp) throw new Error("grant_idempotency_conflict");
          return existing;
        }
        const nowMs = input.nowMs ?? Date.now();
        const autoExpire = input.expireInTwelveMonths ?? (kind === "grant" || kind === "refund" || (kind === "adjust" && input.amountMicroGbp > 0));
        const row: CreditLedgerRow = {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          kind,
          amountMicroGbp: input.amountMicroGbp,
          requestId: input.requestId,
          provider: null,
          model: null,
          tier: null,
          inputTokens: null,
          outputTokens: null,
          createdAt: new Date(nowMs).toISOString(),
          expiresAt: autoExpire ? new Date(defaultGrantExpiresAtMs(nowMs)).toISOString() : null,
          meta: cleanLedgerMeta(input.meta),
        };
        state.ledger.push(row);
        return row;
      });
    },
    async tryReserve(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      assertFingerprint(input.requestFingerprint);
      if (input.amountMicroGbp < 0) throw new Error("reserve must be non-negative");
      return lock(() => {
        const nowMs = input.nowMs ?? Date.now();
        expireDueLocked(input.workspaceId, nowMs);
        const existing = state.reservations.get(input.requestId);
        if (existing && (existing.workspaceId !== input.workspaceId
          || existing.requestFingerprint !== input.requestFingerprint
          || existing.amountMicroGbp !== input.amountMicroGbp)) {
          return { ok: false as const, reason: "conflict" as const };
        }
        if (existing?.status === "settled") return { ok: false as const, reason: "replay" as const, reservation: existing };
        if (existing && isHolding(existing.status)) {
          return { ok: false as const, reason: "in_flight" as const, reservation: existing };
        }
        const lots = lotsOf(input.workspaceId);
        const available = spendableMicroGbp(lots, nowMs) - reservedOf(input.workspaceId);
        if (available < input.amountMicroGbp) return { ok: false as const, reason: "insufficient" as const };
        const funding = planFundingSlices(lots, input.amountMicroGbp, nowMs, openHoldsOf(input.workspaceId));
        if (!funding) return { ok: false as const, reason: "insufficient" as const };
        const stamp = new Date(nowMs).toISOString();
        const reservation: CreditReservation = {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          amountMicroGbp: input.amountMicroGbp,
          status: "reserved",
          requestFingerprint: input.requestFingerprint,
          httpStatus: null,
          funding,
          createdAt: stamp,
          updatedAt: stamp,
        };
        state.reservations.set(input.requestId, reservation);
        return { ok: true as const, reservation };
      });
    },
    async markDispatched(workspaceId, requestId, nowMs = Date.now()) {
      return lock(() => {
        const reservation = state.reservations.get(requestId);
        if (!reservation) return { ok: false as const, reason: "not_reserved" as const };
        if (reservation.workspaceId !== workspaceId) {
          return { ok: false as const, reason: "ownership_mismatch" as const };
        }
        if (reservation.status !== "reserved") {
          return { ok: false as const, reason: "not_reserved" as const };
        }
        const next: CreditReservation = {
          ...reservation,
          status: "dispatched",
          updatedAt: new Date(nowMs).toISOString(),
        };
        state.reservations.set(requestId, next);
        return { ok: true as const, reservation: next };
      });
    },
    async settle(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      assertInt("inputTokens", input.inputTokens);
      assertInt("outputTokens", input.outputTokens);
      return lock(() => {
        const reservation = state.reservations.get(input.requestId);
        if (!reservation || reservation.workspaceId !== input.workspaceId) throw new Error("reservation ownership mismatch");
        if (reservation.status === "released") throw new Error("reservation_released");
        const existing = state.ledger.find((row) => row.requestId === input.requestId);
        if (existing) {
          if (existing.workspaceId !== input.workspaceId || existing.kind !== "usage") throw new Error("settle_idempotency_conflict");
          return existing;
        }
        if (!isHolding(reservation.status) && reservation.status !== "settled") {
          throw new Error("reservation_not_settleable");
        }
        const charge = Math.min(Math.abs(input.amountMicroGbp), reservation.amountMicroGbp);
        const stamp = new Date(input.nowMs ?? Date.now()).toISOString();
        const fundingAuthorizedAtMs = Date.parse(reservation.createdAt);
        const funding = settleFundingSlices(reservation.funding, charge);
        const row: CreditLedgerRow = {
          id: randomUUID(),
          workspaceId: reservation.workspaceId,
          kind: "usage",
          amountMicroGbp: -charge,
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          tier: input.tier,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          createdAt: stamp,
          expiresAt: null,
          meta: cleanLedgerMeta({
            ...input.meta,
            reservedMicroGbp: reservation.amountMicroGbp,
            requestedSettleMicroGbp: Math.abs(input.amountMicroGbp),
            cappedToReservation: Math.abs(input.amountMicroGbp) > reservation.amountMicroGbp,
            fundingAuthorizedAtMs,
            funding,
          }),
        };
        state.ledger.push(row);
        state.reservations.set(input.requestId, {
          ...reservation,
          status: "settled",
          httpStatus: input.httpStatus,
          updatedAt: stamp,
        });
        return row;
      });
    },
    async release(workspaceId, requestId, nowMs = Date.now()) {
      await lock(() => {
        const reservation = state.reservations.get(requestId);
        if (!reservation || reservation.workspaceId !== workspaceId) return;
        if (!isHolding(reservation.status)) return;
        state.reservations.set(requestId, {
          ...reservation,
          status: "released",
          updatedAt: new Date(nowMs).toISOString(),
        });
      });
    },
    async markUncertain(workspaceId, requestId, nowMs = Date.now()) {
      await lock(() => {
        const reservation = state.reservations.get(requestId);
        if (!reservation || reservation.workspaceId !== workspaceId) return;
        if (reservation.status !== "dispatched" && reservation.status !== "reserved") return;
        state.reservations.set(requestId, {
          ...reservation,
          status: "uncertain",
          updatedAt: new Date(nowMs).toISOString(),
        });
      });
    },
    async recoverStaleReservations(input = {}) {
      return lock(() => {
        const nowMs = input.nowMs ?? Date.now();
        const graceMs = input.graceMs ?? RESERVATION_RECOVERY_GRACE_MS;
        const releasedRequestIds: string[] = [];
        const quarantinedRequestIds: string[] = [];
        for (const reservation of state.reservations.values()) {
          if (input.workspaceId && reservation.workspaceId !== input.workspaceId) continue;
          const age = nowMs - Date.parse(reservation.updatedAt || reservation.createdAt);
          if (age < graceMs) continue;
          if (reservation.status === "reserved") {
            // Never forwarded — safe to release; do not fabricate usage.
            state.reservations.set(reservation.requestId, {
              ...reservation,
              status: "released",
              updatedAt: new Date(nowMs).toISOString(),
            });
            releasedRequestIds.push(reservation.requestId);
            continue;
          }
          if (reservation.status === "dispatched" || reservation.status === "uncertain") {
            // Provider outcome unknown — hold funds; operator/J4 reconcile required.
            state.reservations.set(reservation.requestId, {
              ...reservation,
              status: "quarantined",
              updatedAt: new Date(nowMs).toISOString(),
            });
            quarantinedRequestIds.push(reservation.requestId);
          }
        }
        return {
          released: releasedRequestIds.length,
          quarantined: quarantinedRequestIds.length,
          releasedRequestIds,
          quarantinedRequestIds,
        };
      });
    },
    async expireDue(workspaceId, nowMs = Date.now()) {
      return lock(() => expireDueLocked(workspaceId, nowMs));
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
    expiresAt: row.expires_at == null ? null : new Date(String(row.expires_at)).toISOString(),
    meta: (row.meta && typeof row.meta === "object" ? row.meta : {}) as Record<string, unknown>,
  };
}

function mapReservation(row: Record<string, unknown>): CreditReservation {
  return {
    requestId: String(row.request_id),
    workspaceId: String(row.workspace_id),
    amountMicroGbp: num(row.amount_micro_gbp),
    status: row.status as ReservationStatus,
    requestFingerprint: row.request_fingerprint == null ? null : String(row.request_fingerprint),
    httpStatus: row.http_status == null ? null : num(row.http_status),
    funding: parseFundingSlices(row.funding ?? []),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
  };
}

function lotSourcesFromRows(rows: Array<Record<string, unknown>>): CreditLotSource[] {
  return rows.map((row) => {
    const mapped = mapLedger(row);
    const fundingAuthorizedAtMs = mapped.kind === "usage" && typeof mapped.meta.fundingAuthorizedAtMs === "number"
      ? mapped.meta.fundingAuthorizedAtMs
      : null;
    const funding = mapped.kind === "usage" && mapped.meta.funding != null
      ? parseFundingSlices(mapped.meta.funding)
      : null;
    return {
      id: mapped.id,
      kind: mapped.kind,
      amountMicroGbp: mapped.amountMicroGbp,
      createdAtMs: Date.parse(mapped.createdAt),
      expiresAtMs: mapped.expiresAt == null ? null : Date.parse(mapped.expiresAt),
      requestId: mapped.requestId,
      fundingAuthorizedAtMs,
      funding,
    };
  });
}

const HOLDING_SQL = `'reserved','dispatched','uncertain','quarantined'`;

async function openHoldsFromClient(client: PgClient, workspaceId: string): Promise<OpenHold[]> {
  const result = await client.query(
    `SELECT created_at, funding FROM fizot_credit_reservations
      WHERE workspace_id = $1 AND status IN (${HOLDING_SQL})`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    authorizedAtMs: Date.parse(String(row.created_at)),
    funding: parseFundingSlices(row.funding ?? []),
  }));
}

async function expireDueOnClient(
  client: PgClient,
  workspaceId: string,
  nowMs: number,
): Promise<number> {
  const ledger = await client.query(`SELECT * FROM fizot_credit_ledger WHERE workspace_id = $1`, [workspaceId]);
  const holds = await openHoldsFromClient(client, workspaceId);
  const due = expiredGrantResiduals(lotSourcesFromRows(ledger.rows), nowMs, holds);
  let wrote = 0;
  for (const item of due) {
    const expireRequestId = `expire:${item.grantId}`;
    const inserted = await client.query(
      `INSERT INTO fizot_credit_ledger
        (id, workspace_id, kind, amount_micro_gbp, request_id, created_at, meta)
       VALUES ($1, $2, 'expire', $3, $4, $5::timestamptz, $6::jsonb)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        workspaceId,
        -item.residualMicroGbp,
        expireRequestId,
        new Date(nowMs).toISOString(),
        JSON.stringify(cleanLedgerMeta({ grantId: item.grantId, grantRequestId: item.grantRequestId })),
      ],
    );
    if (inserted.rows[0]) wrote += 1;
  }
  return wrote;
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
  kind TEXT NOT NULL,
  amount_micro_gbp BIGINT NOT NULL,
  request_id TEXT UNIQUE,
  provider TEXT,
  model TEXT,
  tier TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE fizot_credit_ledger ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE fizot_credit_ledger DROP CONSTRAINT IF EXISTS fizot_credit_ledger_kind_check;
ALTER TABLE fizot_credit_ledger ADD CONSTRAINT fizot_credit_ledger_kind_check
  CHECK (kind IN ('grant','usage','refund','adjust','expire'));
CREATE TABLE IF NOT EXISTS fizot_credit_reservations (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  amount_micro_gbp BIGINT NOT NULL,
  status TEXT NOT NULL,
  request_fingerprint TEXT,
  http_status INTEGER,
  funding JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE fizot_credit_reservations ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE fizot_credit_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE fizot_credit_reservations ADD COLUMN IF NOT EXISTS funding JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE fizot_credit_reservations DROP CONSTRAINT IF EXISTS fizot_credit_reservations_status_check;
ALTER TABLE fizot_credit_reservations ADD CONSTRAINT fizot_credit_reservations_status_check
  CHECK (status IN ('reserved','dispatched','uncertain','quarantined','settled','released'));
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
    async setIncluded(workspaceId, includedMicroGbp) {
      assertInt("includedMicroGbp", includedMicroGbp);
      await pool.query(
        `INSERT INTO fizot_credit_accounts (workspace_id, included_micro_gbp)
         VALUES ($1, $2)
         ON CONFLICT (workspace_id) DO UPDATE SET included_micro_gbp = EXCLUDED.included_micro_gbp`,
        [workspaceId, includedMicroGbp],
      );
    },
    async summary(workspaceId, now = Date.now()) {
      return withLock(workspaceId, async (client) => {
        await expireDueOnClient(client, workspaceId, now);
        const period = periodKey(now);
        const ledger = await client.query(`SELECT * FROM fizot_credit_ledger WHERE workspace_id = $1`, [workspaceId]);
        const spendable = spendableMicroGbp(lotSourcesFromRows(ledger.rows), now);
        const result = await client.query(
          `SELECT
             (SELECT included_micro_gbp FROM fizot_credit_accounts WHERE workspace_id = $1) AS included,
             (SELECT COALESCE(SUM(-amount_micro_gbp), 0) FROM fizot_credit_ledger
               WHERE workspace_id = $1 AND kind = 'usage' AND to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2) AS usage,
             (SELECT COALESCE(SUM(amount_micro_gbp), 0) FROM fizot_credit_reservations
               WHERE workspace_id = $1 AND status IN (${HOLDING_SQL})) AS reserved`,
          [workspaceId, period],
        );
        const row = result.rows[0] ?? {};
        return {
          balanceMicroGbp: spendable,
          includedMicroGbp: row.included == null ? 0 : num(row.included),
          periodUsageMicroGbp: num(row.usage),
          reservedMicroGbp: num(row.reserved),
          period,
        };
      });
    },
    async grant(input) {
      const kind = input.kind ?? "grant";
      assertGrantInput(kind, input.amountMicroGbp);
      const id = randomUUID();
      const meta = cleanLedgerMeta(input.meta);
      const nowMs = input.nowMs ?? Date.now();
      const autoExpire = input.expireInTwelveMonths ?? (kind === "grant" || kind === "refund" || (kind === "adjust" && input.amountMicroGbp > 0));
      const expiresAt = autoExpire ? new Date(defaultGrantExpiresAtMs(nowMs)).toISOString() : null;
      const inserted = await pool.query(
        `INSERT INTO fizot_credit_ledger
          (id, workspace_id, kind, amount_micro_gbp, request_id, created_at, expires_at, meta)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING *`,
        [id, input.workspaceId, kind, input.amountMicroGbp, input.requestId, new Date(nowMs).toISOString(), expiresAt, JSON.stringify(meta)],
      );
      if (inserted.rows[0]) return mapLedger(inserted.rows[0]);
      const existing = await pool.query(`SELECT * FROM fizot_credit_ledger WHERE request_id = $1`, [input.requestId]);
      if (!existing.rows[0]) throw new Error("grant missing after conflict");
      const prior = mapLedger(existing.rows[0]);
      if (prior.workspaceId !== input.workspaceId || prior.kind !== kind
        || prior.amountMicroGbp !== input.amountMicroGbp) throw new Error("grant_idempotency_conflict");
      return prior;
    },
    async tryReserve(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      assertFingerprint(input.requestFingerprint);
      return withLock(input.workspaceId, async (client) => {
        const nowMs = input.nowMs ?? Date.now();
        await expireDueOnClient(client, input.workspaceId, nowMs);
        const existing = await client.query(
          `SELECT * FROM fizot_credit_reservations WHERE request_id = $1`,
          [input.requestId],
        );
        const prior = existing.rows[0] ? mapReservation(existing.rows[0]) : null;
        if (prior && (prior.workspaceId !== input.workspaceId
          || prior.requestFingerprint !== input.requestFingerprint
          || prior.amountMicroGbp !== input.amountMicroGbp)) {
          return { ok: false as const, reason: "conflict" as const };
        }
        if (prior?.status === "settled") return { ok: false as const, reason: "replay" as const, reservation: prior };
        if (prior && isHolding(prior.status)) {
          return { ok: false as const, reason: "in_flight" as const, reservation: prior };
        }
        const ledger = await client.query(`SELECT * FROM fizot_credit_ledger WHERE workspace_id = $1`, [input.workspaceId]);
        const reserved = await client.query(
          `SELECT COALESCE(SUM(amount_micro_gbp), 0) AS reserved FROM fizot_credit_reservations
            WHERE workspace_id = $1 AND status IN (${HOLDING_SQL})`,
          [input.workspaceId],
        );
        const lots = lotSourcesFromRows(ledger.rows);
        const available = spendableMicroGbp(lots, nowMs) - num(reserved.rows[0]?.reserved);
        if (available < input.amountMicroGbp) return { ok: false as const, reason: "insufficient" as const };
        const openHolds = await openHoldsFromClient(client, input.workspaceId);
        const funding = planFundingSlices(lots, input.amountMicroGbp, nowMs, openHolds);
        if (!funding) return { ok: false as const, reason: "insufficient" as const };
        const stamp = new Date(nowMs).toISOString();
        const inserted = prior
          ? await client.query(
            `UPDATE fizot_credit_reservations
               SET status = 'reserved', amount_micro_gbp = $2, request_fingerprint = $3, http_status = NULL,
                   funding = $5::jsonb, updated_at = $6::timestamptz
             WHERE request_id = $1 AND workspace_id = $4 RETURNING *`,
            [input.requestId, input.amountMicroGbp, input.requestFingerprint, input.workspaceId, JSON.stringify(funding), stamp],
          )
          : await client.query(
            `INSERT INTO fizot_credit_reservations
              (request_id, workspace_id, amount_micro_gbp, status, request_fingerprint, funding, created_at, updated_at)
              VALUES ($1, $2, $3, 'reserved', $4, $5::jsonb, $6::timestamptz, $6::timestamptz)
              ON CONFLICT (request_id) DO NOTHING RETURNING *`,
            [input.requestId, input.workspaceId, input.amountMicroGbp, input.requestFingerprint, JSON.stringify(funding), stamp],
          );
        if (!inserted.rows[0]) return { ok: false as const, reason: "conflict" as const };
        return { ok: true as const, reservation: mapReservation(inserted.rows[0]!) };
      });
    },
    async markDispatched(workspaceId, requestId, nowMs = Date.now()) {
      return withLock(workspaceId, async (client) => {
        const existing = await client.query(
          `SELECT * FROM fizot_credit_reservations WHERE request_id = $1 FOR UPDATE`,
          [requestId],
        );
        if (!existing.rows[0]) return { ok: false as const, reason: "not_reserved" as const };
        const prior = mapReservation(existing.rows[0]);
        if (prior.workspaceId !== workspaceId) {
          return { ok: false as const, reason: "ownership_mismatch" as const };
        }
        if (prior.status !== "reserved") {
          return { ok: false as const, reason: "not_reserved" as const };
        }
        const stamp = new Date(nowMs).toISOString();
        const updated = await client.query(
          `UPDATE fizot_credit_reservations
             SET status = 'dispatched', updated_at = $3::timestamptz
           WHERE request_id = $1 AND workspace_id = $2 AND status = 'reserved'
           RETURNING *`,
          [requestId, workspaceId, stamp],
        );
        if (!updated.rows[0]) return { ok: false as const, reason: "not_reserved" as const };
        return { ok: true as const, reservation: mapReservation(updated.rows[0]) };
      });
    },
    async settle(input) {
      assertInt("amountMicroGbp", input.amountMicroGbp);
      assertInt("inputTokens", input.inputTokens);
      assertInt("outputTokens", input.outputTokens);
      return withLock(input.workspaceId, async (client) => {
        const reservationRow = await client.query(
          `SELECT * FROM fizot_credit_reservations WHERE request_id = $1 FOR UPDATE`,
          [input.requestId],
        );
        const prior = reservationRow.rows[0] ? mapReservation(reservationRow.rows[0]) : null;
        if (!prior || prior.workspaceId !== input.workspaceId) throw new Error("reservation ownership mismatch");
        if (prior.status === "released") throw new Error("reservation_released");
        const existing = await client.query(`SELECT * FROM fizot_credit_ledger WHERE request_id = $1`, [input.requestId]);
        if (existing.rows[0]) {
          const mapped = mapLedger(existing.rows[0]);
          if (mapped.workspaceId !== input.workspaceId || mapped.kind !== "usage") throw new Error("settle_idempotency_conflict");
          return mapped;
        }
        if (!isHolding(prior.status)) throw new Error("reservation_not_settleable");
        const charge = Math.min(Math.abs(input.amountMicroGbp), prior.amountMicroGbp);
        const stamp = new Date(input.nowMs ?? Date.now()).toISOString();
        const fundingAuthorizedAtMs = Date.parse(prior.createdAt);
        const funding = settleFundingSlices(prior.funding, charge);
        const id = randomUUID();
        const inserted = await client.query(
          `INSERT INTO fizot_credit_ledger
            (id, workspace_id, kind, amount_micro_gbp, request_id, provider, model, tier, input_tokens, output_tokens, created_at, meta)
           VALUES ($1, $2, 'usage', $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::jsonb)
           RETURNING *`,
          [
            id,
            prior.workspaceId,
            -charge,
            input.requestId,
            input.provider,
            input.model,
            input.tier,
            input.inputTokens,
            input.outputTokens,
            stamp,
            JSON.stringify(cleanLedgerMeta({
              ...input.meta,
              reservedMicroGbp: prior.amountMicroGbp,
              requestedSettleMicroGbp: Math.abs(input.amountMicroGbp),
              cappedToReservation: Math.abs(input.amountMicroGbp) > prior.amountMicroGbp,
              fundingAuthorizedAtMs,
              funding,
            })),
          ],
        );
        await client.query(
          `UPDATE fizot_credit_reservations
             SET status = 'settled', http_status = $2, updated_at = $4::timestamptz
            WHERE request_id = $1 AND workspace_id = $3`,
          [input.requestId, input.httpStatus, input.workspaceId, stamp],
        );
        return mapLedger(inserted.rows[0]!);
      });
    },
    async release(workspaceId, requestId, nowMs = Date.now()) {
      await pool.query(
        `UPDATE fizot_credit_reservations SET status = 'released', updated_at = $3::timestamptz
          WHERE request_id = $1 AND workspace_id = $2 AND status IN (${HOLDING_SQL})`,
        [requestId, workspaceId, new Date(nowMs).toISOString()],
      );
    },
    async markUncertain(workspaceId, requestId, nowMs = Date.now()) {
      await pool.query(
        `UPDATE fizot_credit_reservations SET status = 'uncertain', updated_at = $3::timestamptz
          WHERE request_id = $1 AND workspace_id = $2 AND status IN ('reserved','dispatched')`,
        [requestId, workspaceId, new Date(nowMs).toISOString()],
      );
    },
    async recoverStaleReservations(input = {}) {
      const nowMs = input.nowMs ?? Date.now();
      const graceMs = input.graceMs ?? RESERVATION_RECOVERY_GRACE_MS;
      const cutoff = new Date(nowMs - graceMs).toISOString();
      const stale = await pool.query(
        `SELECT * FROM fizot_credit_reservations
          WHERE status IN ('reserved','dispatched','uncertain')
            AND updated_at <= $1::timestamptz
            AND ($2::text IS NULL OR workspace_id = $2)`,
        [cutoff, input.workspaceId ?? null],
      );
      const releasedRequestIds: string[] = [];
      const quarantinedRequestIds: string[] = [];
      for (const row of stale.rows) {
        const reservation = mapReservation(row);
        await withLock(reservation.workspaceId, async (client) => {
          const current = await client.query(
            `SELECT * FROM fizot_credit_reservations WHERE request_id = $1 FOR UPDATE`,
            [reservation.requestId],
          );
          if (!current.rows[0]) return;
          const live = mapReservation(current.rows[0]);
          if (live.workspaceId !== reservation.workspaceId) return;
          if (Date.parse(live.updatedAt) > nowMs - graceMs) return;
          const stamp = new Date(nowMs).toISOString();
          if (live.status === "reserved") {
            await client.query(
              `UPDATE fizot_credit_reservations
                 SET status = 'released', updated_at = $2::timestamptz
               WHERE request_id = $1 AND workspace_id = $3`,
              [live.requestId, stamp, live.workspaceId],
            );
            releasedRequestIds.push(live.requestId);
            return;
          }
          if (live.status === "dispatched" || live.status === "uncertain") {
            await client.query(
              `UPDATE fizot_credit_reservations
                 SET status = 'quarantined', updated_at = $2::timestamptz
               WHERE request_id = $1 AND workspace_id = $3`,
              [live.requestId, stamp, live.workspaceId],
            );
            quarantinedRequestIds.push(live.requestId);
          }
        });
      }
      return {
        released: releasedRequestIds.length,
        quarantined: quarantinedRequestIds.length,
        releasedRequestIds,
        quarantinedRequestIds,
      };
    },
    async expireDue(workspaceId, nowMs = Date.now()) {
      return withLock(workspaceId, async (client) => expireDueOnClient(client, workspaceId, nowMs));
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
