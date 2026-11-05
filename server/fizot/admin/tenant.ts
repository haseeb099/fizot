/**
 * Accounts, memberships and sessions for Fizot Admin.
 * Workspace rows are only read through a membership JOIN (same query).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { WorkspaceRecord, WorkspaceStore } from "./store.ts";

export type MembershipRole = "owner" | "admin" | "member";

export const MEMBERSHIP_ROLE_RANK: Record<MembershipRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

export type AccountRecord = {
  id: string;
  email: string;
  createdAt: string;
};

export type MembershipRecord = {
  accountId: string;
  workspaceId: string;
  role: MembershipRole;
  joinedAt: string;
};

export type SessionRecord = {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  rotatedFrom: string | null;
};

export type SessionContext = {
  session: SessionRecord;
  account: AccountRecord;
  token: string;
};

export function roleAtLeast(have: MembershipRole, need: MembershipRole): boolean {
  return MEMBERSHIP_ROLE_RANK[have] >= MEMBERSHIP_ROLE_RANK[need];
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function mintSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface TenantStore {
  createAccount(email: string): Promise<AccountRecord>;
  getAccount(id: string): Promise<AccountRecord | null>;
  getAccountByEmail(email: string): Promise<AccountRecord | null>;
  ensureAccount(email: string): Promise<AccountRecord>;
  upsertMembership(accountId: string, workspaceId: string, role: MembershipRole): Promise<MembershipRecord>;
  getMembership(accountId: string, workspaceId: string): Promise<MembershipRecord | null>;
  /** Workspace only when the account is a member — JOIN in one query. */
  getWorkspaceForMember(accountId: string, workspaceId: string): Promise<{ workspace: WorkspaceRecord; membership: MembershipRecord } | null>;
  listWorkspacesForAccount(accountId: string): Promise<Array<{ workspace: WorkspaceRecord; membership: MembershipRecord }>>;
  /** Members of a workspace (metadata only: account + role + joinedAt). */
  listMembers(workspaceId: string): Promise<Array<{ account: AccountRecord; membership: MembershipRecord }>>;
  deleteMembership(accountId: string, workspaceId: string): Promise<void>;
  revokeAllSessionsForAccount(accountId: string): Promise<number>;
  createSession(accountId: string, opts?: { ttlMs?: number; rotatedFrom?: string | null }): Promise<{ session: SessionRecord; token: string }>;
  resolveSession(token: string): Promise<SessionContext | null>;
  revokeSession(sessionId: string): Promise<void>;
  revokeSessionByToken(token: string): Promise<void>;
  rotateSession(token: string, opts?: { ttlMs?: number }): Promise<{ session: SessionRecord; token: string } | null>;
}

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

export function createMemoryTenantStore(workspaces: WorkspaceStore): TenantStore & {
  accounts: Map<string, AccountRecord>;
  memberships: Map<string, MembershipRecord>;
  sessions: Map<string, SessionRecord>;
} {
  const accounts = new Map<string, AccountRecord>();
  const accountsByEmail = new Map<string, string>();
  const memberships = new Map<string, MembershipRecord>();
  const sessions = new Map<string, SessionRecord>();
  const sessionsByHash = new Map<string, string>();

  const memKey = (accountId: string, workspaceId: string) => `${accountId}:${workspaceId}`;

  return {
    accounts,
    memberships,
    sessions,
    async createAccount(email) {
      const normalised = email.trim().toLowerCase();
      if (accountsByEmail.has(normalised)) throw new Error(`account ${normalised} exists`);
      const record: AccountRecord = { id: randomUUID(), email: normalised, createdAt: new Date().toISOString() };
      accounts.set(record.id, record);
      accountsByEmail.set(normalised, record.id);
      return record;
    },
    async getAccount(id) {
      return accounts.get(id) ?? null;
    },
    async getAccountByEmail(email) {
      const id = accountsByEmail.get(email.trim().toLowerCase());
      return id ? accounts.get(id) ?? null : null;
    },
    async ensureAccount(email) {
      return (await this.getAccountByEmail(email)) ?? this.createAccount(email);
    },
    async upsertMembership(accountId, workspaceId, role) {
      const existing = memberships.get(memKey(accountId, workspaceId));
      const record: MembershipRecord = {
        accountId,
        workspaceId,
        role,
        joinedAt: existing?.joinedAt ?? new Date().toISOString(),
      };
      memberships.set(memKey(accountId, workspaceId), record);
      return record;
    },
    async getMembership(accountId, workspaceId) {
      return memberships.get(memKey(accountId, workspaceId)) ?? null;
    },
    async listMembers(workspaceId) {
      const out: Array<{ account: AccountRecord; membership: MembershipRecord }> = [];
      for (const membership of memberships.values()) {
        if (membership.workspaceId !== workspaceId) continue;
        const account = accounts.get(membership.accountId);
        if (account) out.push({ account, membership });
      }
      return out;
    },
    async deleteMembership(accountId, workspaceId) {
      memberships.delete(memKey(accountId, workspaceId));
    },
    async revokeAllSessionsForAccount(accountId) {
      let n = 0;
      for (const session of sessions.values()) {
        if (session.accountId !== accountId || session.revokedAt) continue;
        sessionsByHash.delete(session.tokenHash);
        sessions.set(session.id, { ...session, revokedAt: new Date().toISOString() });
        n++;
      }
      return n;
    },
    async getWorkspaceForMember(accountId, workspaceId) {
      const membership = memberships.get(memKey(accountId, workspaceId));
      if (!membership) return null;
      const workspace = await workspaces.get(workspaceId);
      if (!workspace) return null;
      return { workspace, membership };
    },
    async listWorkspacesForAccount(accountId) {
      const out: Array<{ workspace: WorkspaceRecord; membership: MembershipRecord }> = [];
      for (const membership of memberships.values()) {
        if (membership.accountId !== accountId) continue;
        const workspace = await workspaces.get(membership.workspaceId);
        if (workspace) out.push({ workspace, membership });
      }
      return out;
    },
    async createSession(accountId, opts) {
      const token = mintSessionToken();
      const now = Date.now();
      const session: SessionRecord = {
        id: randomUUID(),
        accountId,
        tokenHash: hashSessionToken(token),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (opts?.ttlMs ?? DEFAULT_SESSION_TTL_MS)).toISOString(),
        revokedAt: null,
        rotatedFrom: opts?.rotatedFrom ?? null,
      };
      sessions.set(session.id, session);
      sessionsByHash.set(session.tokenHash, session.id);
      return { session, token };
    },
    async resolveSession(token) {
      const id = sessionsByHash.get(hashSessionToken(token));
      if (!id) return null;
      const session = sessions.get(id);
      if (!session || session.revokedAt) return null;
      if (Date.parse(session.expiresAt) <= Date.now()) return null;
      const account = accounts.get(session.accountId);
      if (!account) return null;
      return { session, account, token };
    },
    async revokeSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessionsByHash.delete(session.tokenHash);
      const next = { ...session, revokedAt: new Date().toISOString() };
      sessions.set(sessionId, next);
    },
    async revokeSessionByToken(token) {
      const id = sessionsByHash.get(hashSessionToken(token));
      if (id) await this.revokeSession(id);
    },
    async rotateSession(token, opts) {
      const current = await this.resolveSession(token);
      if (!current) return null;
      await this.revokeSession(current.session.id);
      return this.createSession(current.account.id, { ttlMs: opts?.ttlMs, rotatedFrom: current.session.id });
    },
  };
}

export async function createPostgresTenantStore(
  databaseUrl: string,
  _workspaces: WorkspaceStore,
): Promise<TenantStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fizot_admin_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fizot_admin_memberships (
      account_id TEXT NOT NULL REFERENCES fizot_admin_accounts(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES fizot_admin_workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, workspace_id)
    );
    ALTER TABLE fizot_admin_memberships ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE TABLE IF NOT EXISTS fizot_admin_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES fizot_admin_accounts(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      rotated_from TEXT
    );
    CREATE INDEX IF NOT EXISTS fizot_admin_memberships_account ON fizot_admin_memberships (account_id);
    CREATE INDEX IF NOT EXISTS fizot_admin_sessions_account ON fizot_admin_sessions (account_id);
  `);

  const toAccount = (r: Record<string, unknown>): AccountRecord => ({
    id: String(r.id),
    email: String(r.email),
    createdAt: new Date(String(r.created_at)).toISOString(),
  });
  const toSession = (r: Record<string, unknown>): SessionRecord => ({
    id: String(r.id),
    accountId: String(r.account_id),
    tokenHash: String(r.token_hash),
    createdAt: new Date(String(r.created_at)).toISOString(),
    expiresAt: new Date(String(r.expires_at)).toISOString(),
    revokedAt: r.revoked_at ? new Date(String(r.revoked_at)).toISOString() : null,
    rotatedFrom: r.rotated_from ? String(r.rotated_from) : null,
  });
  const toWorkspace = (r: Record<string, unknown>): WorkspaceRecord => {
    const createdAt = new Date(String(r.created_at)).toISOString();
    const stateRaw = String(r.state ?? "ready");
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
      createdAt,
      requestId: String(r.request_id || r.id),
      state: (["requested", "creating", "ready", "awake", "sleeping", "deleting", "deleted", "failed"].includes(stateRaw)
        ? stateRaw
        : "ready") as WorkspaceRecord["state"],
      stateChangedAt: new Date(String(r.state_changed_at ?? r.created_at)).toISOString(),
      stateReason: String(r.state_reason ?? "created"),
      ...(r.owner_email ? { ownerEmail: String(r.owner_email) } : {}),
      ...(r.team_id ? { teamId: String(r.team_id) } : {}),
      ...(r.team_name ? { teamName: String(r.team_name) } : {}),
    };
  };

  const store: TenantStore & { close(): Promise<void> } = {
    async createAccount(email) {
      const normalised = email.trim().toLowerCase();
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      await pool.query(
        `INSERT INTO fizot_admin_accounts (id, email, created_at) VALUES ($1, $2, $3)`,
        [id, normalised, createdAt],
      );
      return { id, email: normalised, createdAt };
    },
    async getAccount(id) {
      const result = await pool.query(`SELECT * FROM fizot_admin_accounts WHERE id = $1`, [id]);
      return result.rows[0] ? toAccount(result.rows[0]) : null;
    },
    async getAccountByEmail(email) {
      const result = await pool.query(`SELECT * FROM fizot_admin_accounts WHERE lower(email) = lower($1)`, [email]);
      return result.rows[0] ? toAccount(result.rows[0]) : null;
    },
    async ensureAccount(email) {
      return (await store.getAccountByEmail(email)) ?? store.createAccount(email);
    },
    async upsertMembership(accountId, workspaceId, role) {
      const joinedAt = new Date().toISOString();
      const result = await pool.query(
        `INSERT INTO fizot_admin_memberships (account_id, workspace_id, role, joined_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, workspace_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING joined_at`,
        [accountId, workspaceId, role, joinedAt],
      );
      return {
        accountId,
        workspaceId,
        role,
        joinedAt: new Date(String(result.rows[0]?.joined_at ?? joinedAt)).toISOString(),
      };
    },
    async getMembership(accountId, workspaceId) {
      const result = await pool.query(
        `SELECT account_id, workspace_id, role, joined_at FROM fizot_admin_memberships
         WHERE account_id = $1 AND workspace_id = $2`,
        [accountId, workspaceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        accountId: String(row.account_id),
        workspaceId: String(row.workspace_id),
        role: row.role as MembershipRole,
        joinedAt: new Date(String(row.joined_at)).toISOString(),
      };
    },
    async getWorkspaceForMember(accountId, workspaceId) {
      const result = await pool.query(
        `SELECT w.*, m.role AS membership_role, m.joined_at AS membership_joined_at
         FROM fizot_admin_workspaces w
         INNER JOIN fizot_admin_memberships m
           ON m.workspace_id = w.id AND m.account_id = $1
         WHERE w.id = $2`,
        [accountId, workspaceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        workspace: toWorkspace(row),
        membership: {
          accountId,
          workspaceId,
          role: row.membership_role as MembershipRole,
          joinedAt: new Date(String(row.membership_joined_at)).toISOString(),
        },
      };
    },
    async listWorkspacesForAccount(accountId) {
      const result = await pool.query(
        `SELECT w.*, m.role AS membership_role, m.joined_at AS membership_joined_at
         FROM fizot_admin_workspaces w
         INNER JOIN fizot_admin_memberships m
           ON m.workspace_id = w.id AND m.account_id = $1
         ORDER BY w.created_at ASC`,
        [accountId],
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        workspace: toWorkspace(row),
        membership: {
          accountId,
          workspaceId: String(row.id),
          role: row.membership_role as MembershipRole,
          joinedAt: new Date(String(row.membership_joined_at)).toISOString(),
        },
      }));
    },
    async listMembers(workspaceId) {
      const result = await pool.query(
        `SELECT a.*, m.role AS membership_role, m.joined_at AS membership_joined_at, m.workspace_id
         FROM fizot_admin_memberships m
         INNER JOIN fizot_admin_accounts a ON a.id = m.account_id
         WHERE m.workspace_id = $1
         ORDER BY m.joined_at ASC`,
        [workspaceId],
      );
      return result.rows.map((row: Record<string, unknown>) => ({
        account: toAccount(row),
        membership: {
          accountId: String(row.id),
          workspaceId: String(row.workspace_id),
          role: row.membership_role as MembershipRole,
          joinedAt: new Date(String(row.membership_joined_at)).toISOString(),
        },
      }));
    },
    async deleteMembership(accountId, workspaceId) {
      await pool.query(
        `DELETE FROM fizot_admin_memberships WHERE account_id = $1 AND workspace_id = $2`,
        [accountId, workspaceId],
      );
    },
    async revokeAllSessionsForAccount(accountId) {
      const result = await pool.query(
        `UPDATE fizot_admin_sessions SET revoked_at = NOW()
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [accountId],
      );
      return result.rowCount ?? 0;
    },
    async createSession(accountId, opts) {
      const token = mintSessionToken();
      const now = Date.now();
      const session: SessionRecord = {
        id: randomUUID(),
        accountId,
        tokenHash: hashSessionToken(token),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (opts?.ttlMs ?? DEFAULT_SESSION_TTL_MS)).toISOString(),
        revokedAt: null,
        rotatedFrom: opts?.rotatedFrom ?? null,
      };
      await pool.query(
        `INSERT INTO fizot_admin_sessions
          (id, account_id, token_hash, created_at, expires_at, revoked_at, rotated_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [session.id, session.accountId, session.tokenHash, session.createdAt, session.expiresAt, null, session.rotatedFrom],
      );
      return { session, token };
    },
    async resolveSession(token) {
      const result = await pool.query(
        `SELECT s.*, a.id AS account_id_join, a.email, a.created_at AS account_created_at
         FROM fizot_admin_sessions s
         INNER JOIN fizot_admin_accounts a ON a.id = s.account_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
        [hashSessionToken(token)],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        session: toSession(row),
        account: { id: String(row.account_id), email: String(row.email), createdAt: new Date(String(row.account_created_at)).toISOString() },
        token,
      };
    },
    async revokeSession(sessionId) {
      await pool.query(`UPDATE fizot_admin_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
    },
    async revokeSessionByToken(token) {
      await pool.query(
        `UPDATE fizot_admin_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
        [hashSessionToken(token)],
      );
    },
    async rotateSession(token, opts) {
      const current = await store.resolveSession(token);
      if (!current) return null;
      await store.revokeSession(current.session.id);
      return store.createSession(current.account.id, { ttlMs: opts?.ttlMs, rotatedFrom: current.session.id });
    },
    async close() {
      await pool.end();
    },
  };
  return store;
}

/** Constant-time compare of two session tokens (defence in depth for callers). */
export function sessionTokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
