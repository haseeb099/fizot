/**
 * Workspace invites: hashed single-use tokens, email-bound, 7-day expiry.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { MembershipRole, TenantStore } from "./tenant.ts";
import { mayInviteRole } from "./roles.ts";
import { planFlags, seatMaxForPlan, type PlanId } from "./plans.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export type InviteRecord = {
  id: string;
  workspaceId: string;
  email: string;
  role: "admin" | "member";
  tokenHash: string;
  invitedByAccountId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function mintInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export type InviteStore = {
  createInvite(input: Omit<InviteRecord, "id" | "createdAt" | "acceptedAt" | "revokedAt"> & { id?: string }): Promise<InviteRecord>;
  getInviteByTokenHash(tokenHash: string): Promise<InviteRecord | null>;
  listInvites(workspaceId: string): Promise<InviteRecord[]>;
  countPendingInvites(workspaceId: string): Promise<number>;
  acceptInvite(id: string): Promise<void>;
  revokeInvite(id: string): Promise<void>;
};

export function createMemoryInviteStore(): InviteStore & { invites: Map<string, InviteRecord> } {
  const invites = new Map<string, InviteRecord>();
  const byHash = new Map<string, string>();
  return {
    invites,
    async createInvite(input) {
      const id = input.id ?? randomUUID();
      const record: InviteRecord = {
        id,
        workspaceId: input.workspaceId,
        email: input.email.trim().toLowerCase(),
        role: input.role,
        tokenHash: input.tokenHash,
        invitedByAccountId: input.invitedByAccountId,
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        acceptedAt: null,
        revokedAt: null,
      };
      invites.set(id, record);
      byHash.set(record.tokenHash, id);
      return record;
    },
    async getInviteByTokenHash(tokenHash) {
      const id = byHash.get(tokenHash);
      return id ? invites.get(id) ?? null : null;
    },
    async listInvites(workspaceId) {
      return [...invites.values()].filter((i) => i.workspaceId === workspaceId && !i.revokedAt && !i.acceptedAt);
    },
    async countPendingInvites(workspaceId) {
      const now = Date.now();
      return [...invites.values()].filter(
        (i) => i.workspaceId === workspaceId && !i.revokedAt && !i.acceptedAt && Date.parse(i.expiresAt) > now,
      ).length;
    },
    async acceptInvite(id) {
      const inv = invites.get(id);
      if (!inv) return;
      invites.set(id, { ...inv, acceptedAt: new Date().toISOString() });
    },
    async revokeInvite(id) {
      const inv = invites.get(id);
      if (!inv) return;
      invites.set(id, { ...inv, revokedAt: new Date().toISOString() });
    },
  };
}

export async function createPostgresInviteStore(databaseUrl: string): Promise<InviteStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fizot_admin_invites (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES fizot_admin_workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      token_hash TEXT NOT NULL UNIQUE,
      invited_by_account_id TEXT NOT NULL REFERENCES fizot_admin_accounts(id),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS fizot_admin_invites_workspace ON fizot_admin_invites (workspace_id);
  `);
  const toInvite = (r: Record<string, unknown>): InviteRecord => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    email: String(r.email),
    role: r.role as "admin" | "member",
    tokenHash: String(r.token_hash),
    invitedByAccountId: String(r.invited_by_account_id),
    createdAt: new Date(String(r.created_at)).toISOString(),
    expiresAt: new Date(String(r.expires_at)).toISOString(),
    acceptedAt: r.accepted_at ? new Date(String(r.accepted_at)).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(String(r.revoked_at)).toISOString() : null,
  });
  return {
    async createInvite(input) {
      const id = input.id ?? randomUUID();
      const createdAt = new Date().toISOString();
      await pool.query(
        `INSERT INTO fizot_admin_invites
          (id, workspace_id, email, role, token_hash, invited_by_account_id, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, input.workspaceId, input.email.trim().toLowerCase(), input.role, input.tokenHash, input.invitedByAccountId, createdAt, input.expiresAt],
      );
      return {
        id,
        workspaceId: input.workspaceId,
        email: input.email.trim().toLowerCase(),
        role: input.role,
        tokenHash: input.tokenHash,
        invitedByAccountId: input.invitedByAccountId,
        createdAt,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        revokedAt: null,
      };
    },
    async getInviteByTokenHash(tokenHash) {
      const result = await pool.query(`SELECT * FROM fizot_admin_invites WHERE token_hash = $1`, [tokenHash]);
      return result.rows[0] ? toInvite(result.rows[0]) : null;
    },
    async listInvites(workspaceId) {
      const result = await pool.query(
        `SELECT * FROM fizot_admin_invites
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         ORDER BY created_at ASC`,
        [workspaceId],
      );
      return result.rows.map(toInvite);
    },
    async countPendingInvites(workspaceId) {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS n FROM fizot_admin_invites
         WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
        [workspaceId],
      );
      return Number(result.rows[0]?.n ?? 0);
    },
    async acceptInvite(id) {
      await pool.query(`UPDATE fizot_admin_invites SET accepted_at = NOW() WHERE id = $1 AND accepted_at IS NULL`, [id]);
    },
    async revokeInvite(id) {
      await pool.query(`UPDATE fizot_admin_invites SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [id]);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function createWorkspaceInvite(input: {
  tenant: TenantStore;
  invites: InviteStore;
  workspaceId: string;
  plan: PlanId;
  actorAccountId: string;
  actorRole: MembershipRole;
  email: string;
  role: "admin" | "member";
}): Promise<{ ok: true; invite: InviteRecord; token: string } | { ok: false; status: 403 | 404 | 409; error: string; code?: string }> {
  if (!mayInviteRole(input.actorRole, input.role)) {
    return { ok: false, status: 404, error: "not_found" };
  }
  const flags = planFlags(input.plan);
  if (!flags) return { ok: false, status: 404, error: "not_found" };
  const members = await input.tenant.listMembers(input.workspaceId);
  const pending = await input.invites.countPendingInvites(input.workspaceId);
  if (members.length + pending >= seatMaxForPlan(input.plan)) {
    return { ok: false, status: 409, error: "seat_limit", code: "seat_limit" };
  }
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) return { ok: false, status: 404, error: "not_found" };
  if (members.some((m) => m.account.email === email)) {
    return { ok: false, status: 409, error: "already_member", code: "already_member" };
  }
  const token = mintInviteToken();
  const invite = await input.invites.createInvite({
    workspaceId: input.workspaceId,
    email,
    role: input.role,
    tokenHash: hashInviteToken(token),
    invitedByAccountId: input.actorAccountId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  });
  return { ok: true, invite, token };
}

export async function acceptWorkspaceInvite(input: {
  tenant: TenantStore;
  invites: InviteStore;
  token: string;
  sessionEmail: string;
}): Promise<{ ok: true; workspaceId: string; role: "admin" | "member" } | { ok: false; status: 404; error: "not_found" }> {
  const invite = await input.invites.getInviteByTokenHash(hashInviteToken(input.token));
  if (!invite || invite.revokedAt || invite.acceptedAt) return { ok: false, status: 404, error: "not_found" };
  if (Date.parse(invite.expiresAt) <= Date.now()) return { ok: false, status: 404, error: "not_found" };
  if (invite.email !== input.sessionEmail.trim().toLowerCase()) return { ok: false, status: 404, error: "not_found" };
  const account = await input.tenant.ensureAccount(invite.email);
  await input.tenant.upsertMembership(account.id, invite.workspaceId, invite.role);
  await input.invites.acceptInvite(invite.id);
  return { ok: true, workspaceId: invite.workspaceId, role: invite.role };
}
