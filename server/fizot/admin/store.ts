import type { PlanId } from "./plans.ts";

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
};

export interface WorkspaceStore {
  create(record: WorkspaceRecord): Promise<WorkspaceRecord>;
  get(id: string): Promise<WorkspaceRecord | null>;
  getByAppName(appName: string): Promise<WorkspaceRecord | null>;
  listByOwner(ownerEmail: string): Promise<WorkspaceRecord[]>;
  listByTenant(tenantKey: string): Promise<WorkspaceRecord[]>;
  delete(id: string): Promise<void>;
}

export function createMemoryWorkspaceStore(): WorkspaceStore & { rows: Map<string, WorkspaceRecord> } {
  const rows = new Map<string, WorkspaceRecord>();
  return {
    rows,
    async create(record) {
      if (rows.has(record.id)) throw new Error(`workspace ${record.id} exists`);
      rows.set(record.id, record);
      return record;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async getByAppName(appName) {
      for (const row of rows.values()) if (row.appName === appName) return row;
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
    async delete(id) {
      rows.delete(id);
    },
  };
}

/**
 * Postgres-backed store. Used only when ADMIN_DATABASE_URL is set (workflow_dispatch AD-I).
 * Schema: fizot_admin_workspaces.
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
      team_name TEXT
    );
    CREATE INDEX IF NOT EXISTS fizot_admin_workspaces_owner ON fizot_admin_workspaces (owner_email);
    CREATE INDEX IF NOT EXISTS fizot_admin_workspaces_team ON fizot_admin_workspaces (team_id);
  `);

  const toRow = (r: Record<string, unknown>): WorkspaceRecord => ({
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
  });

  return {
    async create(record) {
      await pool.query(
        `INSERT INTO fizot_admin_workspaces
          (id, plan, app_name, network, machine_id, fly_machine_id, fly_volume_id, public_url, role, bootstrap_secret, created_at, owner_email, team_id, team_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          record.id, record.plan, record.appName, record.network, record.machineId, record.flyMachineId,
          record.flyVolumeId, record.publicUrl, record.role, record.bootstrapSecret, record.createdAt,
          record.ownerEmail ?? null, record.teamId ?? null, record.teamName ?? null,
        ],
      );
      return record;
    },
    async get(id) {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces WHERE id = $1`, [id]);
      return result.rows[0] ? toRow(result.rows[0]) : null;
    },
    async getByAppName(appName) {
      const result = await pool.query(`SELECT * FROM fizot_admin_workspaces WHERE app_name = $1`, [appName]);
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
    async delete(id) {
      await pool.query(`DELETE FROM fizot_admin_workspaces WHERE id = $1`, [id]);
    },
    async close() {
      await pool.end();
    },
  };
}
