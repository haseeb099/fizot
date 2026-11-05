import type { PlanId } from "./plans.ts";
import {
  assertTransition,
  isWorkspaceState,
  type StateTransition,
  type WorkspaceState,
} from "./lifecycle.ts";

export type WorkspaceRecord = {
  id: string;
  plan: PlanId;
  appName: string;
  network: string;
  machineId: string;
  flyMachineId: string;
  flyVolumeId: string;
  publicUrl: string;
  role: "home" | "team";
  bootstrapSecret: string;
  createdAt: string;
  ownerEmail?: string;
  teamId?: string;
  teamName?: string;
  /** Idempotent create key — same requestId never makes a second Fly app. */
  requestId: string;
  state: WorkspaceState;
  stateChangedAt: string;
  stateReason: string;
};

export type DeletionReceipt = {
  /** SHA-256 of workspace id (no personal data). */
  workspaceIdHash: string;
  workspaceId: string;
  /** Fly app name captured at delete-request time for resume after row purge. */
  appName: string | null;
  requestedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  stepsDone: string[];
  status: "pending" | "running" | "complete" | "failed";
  lastError: string | null;
  alertedAt12h: string | null;
  lastAlertAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
};

export interface WorkspaceStore {
  create(record: WorkspaceRecord): Promise<WorkspaceRecord>;
  get(id: string): Promise<WorkspaceRecord | null>;
  getByAppName(appName: string): Promise<WorkspaceRecord | null>;
  getByRequestId(requestId: string): Promise<WorkspaceRecord | null>;
  listByOwner(ownerEmail: string): Promise<WorkspaceRecord[]>;
  listByTenant(tenantKey: string): Promise<WorkspaceRecord[]>;
  listAll(): Promise<WorkspaceRecord[]>;
  update(id: string, patch: Partial<WorkspaceRecord>): Promise<WorkspaceRecord>;
  transition(id: string, toState: WorkspaceState, reason: string, now?: () => number): Promise<WorkspaceRecord>;
  listTransitions(workspaceId: string): Promise<StateTransition[]>;
  /** Remove transition history for a workspace (kept out of erasure evidence). */
  deleteTransitions(workspaceId: string): Promise<number>;
  delete(id: string): Promise<void>;
  upsertDeletionReceipt(receipt: DeletionReceipt): Promise<DeletionReceipt>;
  getDeletionReceipt(workspaceId: string): Promise<DeletionReceipt | null>;
  getDeletionReceiptByHash(workspaceIdHash: string): Promise<DeletionReceipt | null>;
  listDeletionReceipts(): Promise<DeletionReceipt[]>;
  /**
   * Exclusive lease so two Admin instances never run the same deletion.
   * Returns true if acquired (or already held by the same owner).
   */
  tryAcquireDeletionLease(workspaceId: string, ownerId: string, ttlMs: number, now?: () => number): Promise<boolean>;
  releaseDeletionLease(workspaceId: string, ownerId: string): Promise<void>;
}

function defaultLifecycle(partial: Partial<WorkspaceRecord> & Pick<WorkspaceRecord, "id" | "plan" | "appName" | "network" | "machineId" | "flyMachineId" | "flyVolumeId" | "publicUrl" | "role" | "bootstrapSecret" | "createdAt">): WorkspaceRecord {
  const createdAt = partial.createdAt;
  return {
    ...partial,
    requestId: partial.requestId ?? partial.id,
    state: partial.state ?? "ready",
    stateChangedAt: partial.stateChangedAt ?? createdAt,
    stateReason: partial.stateReason ?? "created",
  };
}

export function createMemoryWorkspaceStore(): WorkspaceStore & {
  rows: Map<string, WorkspaceRecord>;
  transitions: StateTransition[];
  receipts: Map<string, DeletionReceipt>;
} {
  const rows = new Map<string, WorkspaceRecord>();
  const transitions: StateTransition[] = [];
  const receipts = new Map<string, DeletionReceipt>();
  return {
    rows,
    transitions,
    receipts,
    async create(record) {
      const full = defaultLifecycle(record);
      if (rows.has(full.id)) throw new Error(`workspace ${full.id} exists`);
      for (const row of rows.values()) {
        if (row.requestId === full.requestId) throw Object.assign(new Error("request_id_conflict"), { status: 409, code: "request_id_conflict" });
      }
      rows.set(full.id, full);
      transitions.push({
        workspaceId: full.id,
        fromState: null,
        toState: full.state,
        at: full.stateChangedAt,
        reason: full.stateReason,
      });
      return full;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async getByAppName(appName) {
      for (const row of rows.values()) if (row.appName === appName) return row;
      return null;
    },
    async getByRequestId(requestId) {
      for (const row of rows.values()) if (row.requestId === requestId) return row;
      return null;
    },
    async listByOwner(ownerEmail) {
      const needle = ownerEmail.trim().toLowerCase();
      return [...rows.values()].filter((row) => row.ownerEmail?.toLowerCase() === needle);
    },
    async listByTenant(tenantKey) {
      const needle = tenantKey.trim().toLowerCase();
      return [...rows.values()].filter((row) =>
        row.teamId?.toLowerCase() === needle
        || row.ownerEmail?.toLowerCase() === needle
        || row.id.toLowerCase() === needle,
      );
    },
    async listAll() {
      return [...rows.values()];
    },
    async update(id, patch) {
      const cur = rows.get(id);
      if (!cur) throw Object.assign(new Error("not_found"), { status: 404 });
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      return next;
    },
    async transition(id, toState, reason, now = Date.now) {
      const cur = rows.get(id);
      if (!cur) throw Object.assign(new Error("not_found"), { status: 404 });
      assertTransition(cur.state, toState, reason);
      const at = new Date(now()).toISOString();
      transitions.push({ workspaceId: id, fromState: cur.state, toState, at, reason });
      const next = { ...cur, state: toState, stateChangedAt: at, stateReason: reason };
      rows.set(id, next);
      return next;
    },
    async listTransitions(workspaceId) {
      return transitions.filter((t) => t.workspaceId === workspaceId);
    },
    async deleteTransitions(workspaceId) {
      let n = 0;
      for (let i = transitions.length - 1; i >= 0; i--) {
        if (transitions[i]!.workspaceId === workspaceId) {
          transitions.splice(i, 1);
          n++;
        }
      }
      return n;
    },
    async delete(id) {
      rows.delete(id);
    },
    async upsertDeletionReceipt(receipt) {
      const prev = receipts.get(receipt.workspaceId);
      // Lease columns are owned by tryAcquire/release — never clobber from status upserts.
      const next: DeletionReceipt = {
        ...receipt,
        appName: receipt.appName ?? prev?.appName ?? null,
        leaseOwner: receipt.status === "complete" ? null : (prev?.leaseOwner ?? null),
        leaseUntil: receipt.status === "complete" ? null : (prev?.leaseUntil ?? null),
      };
      receipts.set(receipt.workspaceId, next);
      return receipts.get(receipt.workspaceId)!;
    },
    async getDeletionReceipt(workspaceId) {
      return receipts.get(workspaceId) ?? null;
    },
    async getDeletionReceiptByHash(workspaceIdHash) {
      for (const r of receipts.values()) if (r.workspaceIdHash === workspaceIdHash) return r;
      return null;
    },
    async listDeletionReceipts() {
      return [...receipts.values()];
    },
    async tryAcquireDeletionLease(workspaceId, ownerId, ttlMs, now = Date.now) {
      const receipt = receipts.get(workspaceId);
      if (!receipt) return false;
      const at = now();
      const until = receipt.leaseUntil ? Date.parse(receipt.leaseUntil) : 0;
      if (receipt.leaseOwner && receipt.leaseOwner !== ownerId && until > at) return false;
      receipts.set(workspaceId, {
        ...receipt,
        leaseOwner: ownerId,
        leaseUntil: new Date(at + ttlMs).toISOString(),
      });
      return true;
    },
    async releaseDeletionLease(workspaceId, ownerId) {
      const receipt = receipts.get(workspaceId);
      if (!receipt || receipt.leaseOwner !== ownerId) return;
      receipts.set(workspaceId, { ...receipt, leaseOwner: null, leaseUntil: null });
    },
  };
}

/**
 * Postgres-backed store. Used when ADMIN_DATABASE_URL is set (workflow_dispatch AD-I).
 */
export async function createPostgresWorkspaceStore(databaseUrl: string): Promise<WorkspaceStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fizot_admin_workspaces (
      id TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      app_name TEXT NOT NULL UNIQUE,
      network TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      fly_machine_id TEXT NOT NULL,
      fly_volume_id TEXT NOT NULL,
      public_url TEXT NOT NULL,
      role TEXT NOT NULL,
      bootstrap_secret TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      owner_email TEXT,
      team_id TEXT,
      team_name TEXT,
      request_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'ready',
      state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      state_reason TEXT NOT NULL DEFAULT 'created'
    );
    ALTER TABLE fizot_admin_workspaces ADD COLUMN IF NOT EXISTS request_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE fizot_admin_workspaces ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'ready';
    ALTER TABLE fizot_admin_workspaces ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE fizot_admin_workspaces ADD COLUMN IF NOT EXISTS state_reason TEXT NOT NULL DEFAULT 'created';
    CREATE UNIQUE INDEX IF NOT EXISTS fizot_admin_workspaces_request ON fizot_admin_workspaces (request_id) WHERE request_id <> '';
    CREATE INDEX IF NOT EXISTS fizot_admin_workspaces_owner ON fizot_admin_workspaces (owner_email);
    CREATE INDEX IF NOT EXISTS fizot_admin_workspaces_team ON fizot_admin_workspaces (team_id);
    CREATE INDEX IF NOT EXISTS fizot_admin_workspaces_state ON fizot_admin_workspaces (state);

    CREATE TABLE IF NOT EXISTS fizot_admin_workspace_transitions (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fizot_admin_workspace_transitions_ws ON fizot_admin_workspace_transitions (workspace_id);

    CREATE TABLE IF NOT EXISTS fizot_admin_deletion_receipts (
      workspace_id TEXT PRIMARY KEY,
      workspace_id_hash TEXT NOT NULL UNIQUE,
      requested_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      steps_done JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      last_error TEXT,
      alerted_at_12h TIMESTAMPTZ,
      last_alert_at TIMESTAMPTZ,
      app_name TEXT,
      lease_owner TEXT,
      lease_until TIMESTAMPTZ
    );
    ALTER TABLE fizot_admin_deletion_receipts ADD COLUMN IF NOT EXISTS app_name TEXT;
    ALTER TABLE fizot_admin_deletion_receipts ADD COLUMN IF NOT EXISTS lease_owner TEXT;
    ALTER TABLE fizot_admin_deletion_receipts ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
  `);

  const toRow = (r: Record<string, unknown>): WorkspaceRecord => {
    const stateRaw = String(r.state ?? "ready");
    const state = isWorkspaceState(stateRaw) ? stateRaw : "ready";
    return {
      id: String(r.id),
      plan: r.plan as WorkspaceRecord["plan"],
      appName: String(r.app_name),
      network: String(r.network),
      machineId: String(r.machine_id),
      flyMachineId: String(r.fly_machine_id),
      flyVolumeId: String(r.fly_volume_id),
      publicUrl: String(r.public_url),
      role: r.role as WorkspaceRecord["role"],
      bootstrapSecret: String(r.bootstrap_secret),
      createdAt: new Date(String(r.created_at)).toISOString(),
      ...(r.owner_email ? { ownerEmail: String(r.owner_email) } : {}),
      ...(r.team_id ? { teamId: String(r.team_id) } : {}),
      ...(r.team_name ? { teamName: String(r.team_name) } : {}),
      requestId: String(r.request_id || r.id),
      state,
      stateChangedAt: new Date(String(r.state_changed_at ?? r.created_at)).toISOString(),
      stateReason: String(r.state_reason ?? "created"),
    };
  };

  const toReceipt = (r: Record<string, unknown>): DeletionReceipt => ({
    workspaceId: String(r.workspace_id),
    workspaceIdHash: String(r.workspace_id_hash),
    appName: r.app_name == null ? null : String(r.app_name),
    requestedAt: new Date(String(r.requested_at)).toISOString(),
    completedAt: r.completed_at ? new Date(String(r.completed_at)).toISOString() : null,
    failedAt: r.failed_at ? new Date(String(r.failed_at)).toISOString() : null,
    stepsDone: Array.isArray(r.steps_done) ? r.steps_done.map(String) : JSON.parse(String(r.steps_done ?? "[]")),
    status: r.status as DeletionReceipt["status"],
    lastError: r.last_error == null ? null : String(r.last_error),
    alertedAt12h: r.alerted_at_12h ? new Date(String(r.alerted_at_12h)).toISOString() : null,
    lastAlertAt: r.last_alert_at ? new Date(String(r.last_alert_at)).toISOString() : null,
    leaseOwner: r.lease_owner == null ? null : String(r.lease_owner),
    leaseUntil: r.lease_until ? new Date(String(r.lease_until)).toISOString() : null,
  });

  const api: WorkspaceStore & { close(): Promise<void> } = {
    async create(record) {
      const full = defaultLifecycle(record);
      await pool.query(
        `INSERT INTO fizot_admin_workspaces
          (id, plan, app_name, network, machine_id, fly_machine_id, fly_volume_id, public_url, role, bootstrap_secret, created_at, owner_email, team_id, team_name, request_id, state, state_changed_at, state_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          full.id, full.plan, full.appName, full.network, full.machineId, full.flyMachineId,
          full.flyVolumeId, full.publicUrl, full.role, full.bootstrapSecret, full.createdAt,
          full.ownerEmail ?? null, full.teamId ?? null, full.teamName ?? null,
          full.requestId, full.state, full.stateChangedAt, full.stateReason,
        ],
      );
      await pool.query(
        `INSERT INTO fizot_admin_workspace_transitions (workspace_id, from_state, to_state, at, reason)
         VALUES ($1, NULL, $2, $3, $4)`,
        [full.id, full.state, full.stateChangedAt, full.stateReason],
      );
      return full;
    },
    async get(id) {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces WHERE id = $1`, [id]);
      return result.rows[0] ? toRow(result.rows[0]) : null;
    },
    async getByAppName(appName) {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces WHERE app_name = $1`, [appName]);
      return result.rows[0] ? toRow(result.rows[0]) : null;
    },
    async getByRequestId(requestId) {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces WHERE request_id = $1`, [requestId]);
      return result.rows[0] ? toRow(result.rows[0]) : null;
    },
    async listByOwner(ownerEmail) {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces WHERE lower(owner_email) = lower($1)`, [ownerEmail]);
      return result.rows.map(toRow);
    },
    async listByTenant(tenantKey) {
      const result = await pool.query(
        `SELECT * FROM fizot_admin_workspaces
         WHERE lower(id) = lower($1) OR lower(owner_email) = lower($1) OR lower(team_id) = lower($1)`,
        [tenantKey],
      );
      return result.rows.map(toRow);
    },
    async listAll() {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces`);
      return result.rows.map(toRow);
    },
    async update(id, patch) {
      const cur = await api.get(id);
      if (!cur) throw Object.assign(new Error("not_found"), { status: 404 });
      const next = { ...cur, ...patch, id: cur.id };
      await pool.query(
        `UPDATE fizot_admin_workspaces SET
          plan=$2, app_name=$3, network=$4, machine_id=$5, fly_machine_id=$6, fly_volume_id=$7,
          public_url=$8, role=$9, bootstrap_secret=$10, owner_email=$11, team_id=$12, team_name=$13,
          request_id=$14, state=$15, state_changed_at=$16, state_reason=$17
         WHERE id=$1`,
        [
          next.id, next.plan, next.appName, next.network, next.machineId, next.flyMachineId,
          next.flyVolumeId, next.publicUrl, next.role, next.bootstrapSecret,
          next.ownerEmail ?? null, next.teamId ?? null, next.teamName ?? null,
          next.requestId, next.state, next.stateChangedAt, next.stateReason,
        ],
      );
      return next;
    },
    async transition(id, toState, reason, now = Date.now) {
      const cur = await api.get(id);
      if (!cur) throw Object.assign(new Error("not_found"), { status: 404 });
      assertTransition(cur.state, toState, reason);
      const at = new Date(now()).toISOString();
      await pool.query(
        `INSERT INTO fizot_admin_workspace_transitions (workspace_id, from_state, to_state, at, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, cur.state, toState, at, reason],
      );
      return api.update(id, { state: toState, stateChangedAt: at, stateReason: reason });
    },
    async listTransitions(workspaceId) {
      const result = await pool.query(
        `SELECT * FROM fizot_admin_workspace_transitions WHERE workspace_id = $1 ORDER BY id ASC`,
        [workspaceId],
      );
      return result.rows.map((r: Record<string, unknown>) => ({
        workspaceId: String(r.workspace_id),
        fromState: r.from_state == null ? null : (isWorkspaceState(r.from_state) ? r.from_state : null),
        toState: (isWorkspaceState(r.to_state) ? r.to_state : "failed") as WorkspaceState,
        at: new Date(String(r.at)).toISOString(),
        reason: String(r.reason),
      }));
    },
    async deleteTransitions(workspaceId) {
      const result = await pool.query(
        `DELETE FROM fizot_admin_workspace_transitions WHERE workspace_id = $1`,
        [workspaceId],
      );
      return result.rowCount ?? 0;
    },
    async delete(id) {
      await pool.query(`DELETE FROM fizot_admin_workspaces WHERE id = $1`, [id]);
    },
    async upsertDeletionReceipt(receipt) {
      // Lease columns stay under tryAcquire/release; complete clears them.
      await pool.query(
        `INSERT INTO fizot_admin_deletion_receipts
          (workspace_id, workspace_id_hash, requested_at, completed_at, failed_at, steps_done, status, last_error, alerted_at_12h, last_alert_at, app_name, lease_owner, lease_until)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,NULL,NULL)
         ON CONFLICT (workspace_id) DO UPDATE SET
           completed_at=EXCLUDED.completed_at, failed_at=EXCLUDED.failed_at, steps_done=EXCLUDED.steps_done,
           status=EXCLUDED.status, last_error=EXCLUDED.last_error, alerted_at_12h=EXCLUDED.alerted_at_12h,
           last_alert_at=EXCLUDED.last_alert_at,
           app_name=COALESCE(EXCLUDED.app_name, fizot_admin_deletion_receipts.app_name),
           workspace_id_hash=EXCLUDED.workspace_id_hash,
           lease_owner=CASE WHEN EXCLUDED.status = 'complete' THEN NULL ELSE fizot_admin_deletion_receipts.lease_owner END,
           lease_until=CASE WHEN EXCLUDED.status = 'complete' THEN NULL ELSE fizot_admin_deletion_receipts.lease_until END`,
        [
          receipt.workspaceId, receipt.workspaceIdHash, receipt.requestedAt, receipt.completedAt,
          receipt.failedAt, JSON.stringify(receipt.stepsDone), receipt.status, receipt.lastError,
          receipt.alertedAt12h, receipt.lastAlertAt, receipt.appName,
        ],
      );
      return receipt;
    },
    async getDeletionReceipt(workspaceId) {
      const result = await pool.query(`SELECT * FROM fizot_admin_deletion_receipts WHERE workspace_id = $1`, [workspaceId]);
      return result.rows[0] ? toReceipt(result.rows[0]) : null;
    },
    async getDeletionReceiptByHash(workspaceIdHash) {
      const result = await pool.query(`SELECT * FROM fizot_admin_deletion_receipts WHERE workspace_id_hash = $1`, [workspaceIdHash]);
      return result.rows[0] ? toReceipt(result.rows[0]) : null;
    },
    async listDeletionReceipts() {
      const result = await pool.query(`SELECT * FROM fizot_admin_deletion_receipts`);
      return result.rows.map(toReceipt);
    },
    async tryAcquireDeletionLease(workspaceId, ownerId, ttlMs, now = Date.now) {
      // Row lease (atomic UPDATE) — pool-safe; two Admin instances never both succeed.
      const at = now();
      const until = new Date(at + ttlMs).toISOString();
      const result = await pool.query(
        `UPDATE fizot_admin_deletion_receipts
         SET lease_owner = $2, lease_until = $3
         WHERE workspace_id = $1
           AND (lease_owner IS NULL OR lease_owner = $2 OR lease_until IS NULL OR lease_until < $4::timestamptz)
         RETURNING workspace_id`,
        [workspaceId, ownerId, until, new Date(at).toISOString()],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async releaseDeletionLease(workspaceId, ownerId) {
      await pool.query(
        `UPDATE fizot_admin_deletion_receipts
         SET lease_owner = NULL, lease_until = NULL
         WHERE workspace_id = $1 AND lease_owner = $2`,
        [workspaceId, ownerId],
      );
    },
    async close() {
      await pool.end();
    },
  };
  return api;
}
