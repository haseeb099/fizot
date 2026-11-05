import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FakeAuthProvider,
  formatClearSessionCookie,
  formatSessionCookie,
  readSessionToken,
  resolveRequestSession,
  signInWithProvider,
  type AuthProvider,
} from "./auth.ts";
import { authorizeWorkspaceAccess, type AuthorizeOk } from "./authorize.ts";
import {
  acceptWorkspaceInvite,
  createWorkspaceInvite,
  type InviteStore,
} from "./invites.ts";
import { eraseAccount } from "./deletion.ts";
import { mayChangeMemberRole, mayRemoveMember } from "./roles.ts";
import {
  buildDispatchTable,
  matchDispatchEntry,
  ROUTE_REGISTRY,
  type DispatchEntry,
} from "./route-registry.ts";
import { safeLogLine } from "./redact.ts";
import type { PlanId } from "./plans.ts";
import { roleAtLeast, type MembershipRole, type SessionContext, type TenantStore } from "./tenant.ts";
import {
  createMemoryWebhookEventStore,
  deliverWebhookEvent,
  resolveWebhookSecret,
  verifyHmacSha256,
  verifyStripeSignature,
  type WebhookEventStore,
} from "./webhooks.ts";
import type { AdminServices } from "./workspaces.ts";
import { openWorkspaceSession } from "../edge/routing.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return 500;
}

/** Member metadata only — never private-chat content. */
function memberPublic(row: { account: { id: string; email: string }; membership: { role: MembershipRole; joinedAt: string } }) {
  return {
    accountId: row.account.id,
    email: row.account.email,
    role: row.membership.role,
    joinedAt: row.membership.joinedAt,
  };
}

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  session: SessionContext | null;
  authz: AuthorizeOk | null;
  services: AdminServices;
  tenant: TenantStore;
  invites: InviteStore;
  auth: AuthProvider;
  cookieSecure: boolean;
  allowFakeSignIn: boolean;
  webhooks: WebhookEventStore;
  rawBody: Buffer;
};

export type AdminHandlerDeps = {
  services: AdminServices;
  tenant: TenantStore;
  invites: InviteStore;
  auth: AuthProvider;
  cookieSecure?: boolean;
  allowFakeSignIn?: boolean;
  webhooks?: WebhookEventStore;
};

function buildHandlers(): Record<string, (ctx: RouteContext) => Promise<void>> {
  return {
    async "edge.health"(ctx) {
      send(ctx.res, 200, { ok: true, service: "fizot-edge" });
    },
    async "edge.fakeSignIn"(ctx) {
      if (!ctx.allowFakeSignIn) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const body = await readJson(ctx.req) as { email?: string };
      const prior = readSessionToken(ctx.req);
      const signed = await signInWithProvider({
        tenant: ctx.tenant,
        auth: ctx.auth,
        email: body.email ?? "",
        priorToken: prior,
      });
      send(ctx.res, 200, { ok: true, accountId: signed.account.id, email: signed.account.email }, {
        "set-cookie": formatSessionCookie(signed.token, { secure: ctx.cookieSecure, maxAgeSec: 7 * 24 * 3600 }),
      });
    },
    async "edge.signOut"(ctx) {
      if (ctx.session) await ctx.tenant.revokeSession(ctx.session.session.id);
      send(ctx.res, 200, { ok: true }, {
        "set-cookie": formatClearSessionCookie({ secure: ctx.cookieSecure }),
      });
    },
    async "edge.me"(ctx) {
      const rows = await ctx.tenant.listWorkspacesForAccount(ctx.session!.account.id);
      send(ctx.res, 200, {
        ok: true,
        account: { id: ctx.session!.account.id, email: ctx.session!.account.email },
        workspaces: rows.map((r) => ({
          id: r.workspace.id,
          plan: r.workspace.plan,
          role: r.membership.role,
          publicUrl: r.workspace.publicUrl,
        })),
      });
    },
    async "edge.openWorkspace"(ctx) {
      const body = await readJson(ctx.req).catch(() => ({})) as { label?: string; role?: string };
      const result = await openWorkspaceSession({
        tenant: ctx.tenant,
        session: ctx.authz!.session,
        workspaceId: ctx.authz!.workspace.id,
        services: ctx.services,
        label: body.label,
        requestedRole: body.role,
      });
      if (!result.ok) {
        send(ctx.res, result.status, { error: result.error });
        return;
      }
      send(ctx.res, 200, result);
    },
    async "edge.acceptInvite"(ctx) {
      const token = ctx.params.token;
      if (!token) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const result = await acceptWorkspaceInvite({
        tenant: ctx.tenant,
        invites: ctx.invites,
        token,
        sessionEmail: ctx.session!.account.email,
      });
      if (!result.ok) {
        send(ctx.res, result.status, { error: result.error });
        return;
      }
      send(ctx.res, 200, { ok: true, workspaceId: result.workspaceId, role: result.role });
    },
    async "admin.createWorkspace"(ctx) {
      const body = await readJson(ctx.req) as {
        plan?: string;
        ownerEmail?: string;
        teamId?: string;
        teamName?: string;
        requestId?: string;
      };
      if (body.plan !== "home" && body.plan !== "team") {
        send(ctx.res, 400, { error: "unknown_plan" });
        return;
      }
      const ownerEmail = body.ownerEmail?.trim().toLowerCase() || ctx.session!.account.email;
      if (ownerEmail !== ctx.session!.account.email) {
        send(ctx.res, 403, { error: "forbidden_owner" });
        return;
      }
      const record = await ctx.services.createWorkspace({
        plan: body.plan as PlanId,
        ownerEmail,
        teamId: body.teamId ?? (body.plan === "team" ? `team-${randomUUID()}` : undefined),
        teamName: body.teamName ?? (body.plan === "team" ? "Team" : undefined),
        requestId: body.requestId,
      });
      await ctx.tenant.upsertMembership(ctx.session!.account.id, record.id, "owner");
      const { bootstrapSecret: _secret, ...publicRecord } = record;
      void _secret;
      send(ctx.res, 201, { ok: true, workspace: publicRecord });
    },
    async "admin.listWorkspaces"(ctx) {
      const rows = await ctx.tenant.listWorkspacesForAccount(ctx.session!.account.id);
      send(ctx.res, 200, {
        ok: true,
        workspaces: rows.map((r) => ({
          id: r.workspace.id,
          plan: r.workspace.plan,
          role: r.membership.role,
          publicUrl: r.workspace.publicUrl,
          appName: r.workspace.appName,
        })),
      });
    },
    async "admin.destroyWorkspace"(ctx) {
      const result = await ctx.services.destroyWorkspace(ctx.authz!.workspace.id);
      send(ctx.res, 202, {
        ok: true,
        deleting: true,
        appName: result.appName,
        receipt: {
          workspaceIdHash: result.receipt.workspaceIdHash,
          status: result.receipt.status,
          requestedAt: result.receipt.requestedAt,
          stepsDone: result.receipt.stepsDone,
        },
      });
    },
    async "admin.deletionReceipt"(ctx) {
      const workspaceId = ctx.params.workspaceId;
      if (!workspaceId) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const membership = await ctx.tenant.getMembership(ctx.session!.account.id, workspaceId);
      const receipt = await ctx.services.getDeletionReceipt(workspaceId);
      if (!receipt) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      // While the workspace exists, require admin+; after erasure only the receipt remains.
      if (membership && !roleAtLeast(membership.role, "admin")) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      send(ctx.res, 200, {
        ok: true,
        receipt: {
          workspaceIdHash: receipt.workspaceIdHash,
          status: receipt.status,
          requestedAt: receipt.requestedAt,
          completedAt: receipt.completedAt,
          failedAt: receipt.failedAt,
          stepsDone: receipt.stepsDone,
        },
      });
    },
    async "admin.eraseAccount"(ctx) {
      const body = await readJson(ctx.req).catch(() => ({})) as { confirm?: string };
      if (body.confirm !== "erase") {
        send(ctx.res, 400, { error: "confirm_required" });
        return;
      }
      const result = await eraseAccount({
        accountId: ctx.session!.account.id,
        tenant: ctx.tenant,
        store: ctx.services.store,
        runner: ctx.services.deletionRunner,
        memberLeft: async (workspaceId, email) => {
          await ctx.services.workspaceMemberLeft(workspaceId, email).catch(() => undefined);
        },
      });
      send(ctx.res, 200, {
        ok: true,
        erased: true,
        deletedWorkspaceIds: result.deletedWorkspaceIds,
        leftWorkspaceIds: result.leftWorkspaceIds,
        receipts: result.receipts.map((r) => ({
          workspaceIdHash: r.workspaceIdHash,
          status: r.status,
          completedAt: r.completedAt,
          stepsDone: r.stepsDone,
        })),
      });
    },
    async "admin.webhook"(ctx) {
      const provider = (ctx.params.provider ?? "").toLowerCase();
      if (provider !== "generic" && provider !== "stripe") {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const secret = resolveWebhookSecret(provider);
      if (!secret) {
        send(ctx.res, 401, { error: "unauthorized" });
        return;
      }
      const raw = ctx.rawBody.toString("utf8");
      const verified = provider === "stripe"
        ? verifyStripeSignature({
          secret,
          body: raw,
          header: String(ctx.req.headers["stripe-signature"] ?? ""),
        })
        : verifyHmacSha256({
          secret,
          body: raw,
          signature: String(ctx.req.headers["x-fizot-signature"] ?? ctx.req.headers["x-webhook-signature"] ?? ""),
          timestamp: String(ctx.req.headers["x-fizot-timestamp"] ?? ctx.req.headers["x-webhook-timestamp"] ?? ""),
        });
      if (!verified.ok) {
        send(ctx.res, verified.error === "missing_signature" || verified.error === "invalid_signature" ? 401 : 400, {
          error: verified.error,
        });
        return;
      }
      let payload: { id?: string; type?: string } = {};
      try {
        payload = JSON.parse(raw || "{}") as { id?: string; type?: string };
      } catch {
        send(ctx.res, 400, { error: "invalid_json" });
        return;
      }
      const eventId = typeof payload.id === "string" && payload.id ? payload.id : "";
      if (!eventId) {
        send(ctx.res, 400, { error: "missing_event_id" });
        return;
      }
      const delivered = await deliverWebhookEvent({
        store: ctx.webhooks,
        provider,
        eventId,
        handler: async () => ({ type: payload.type ?? "unknown", accepted: true }),
      });
      if (!delivered.delivered) {
        send(ctx.res, 200, { ok: true, duplicate: true });
        return;
      }
      send(ctx.res, 200, { ok: true, duplicate: false, result: delivered.result });
    },
    async "admin.health"(ctx) {
      const result = await ctx.services.workspaceHealth(ctx.authz!.workspace.id);
      send(ctx.res, result.status, result.body);
    },
    async "admin.power"(ctx) {
      const idleRaw = ctx.url.searchParams.get("idleMinutes");
      const idleMinutes = idleRaw && /^\d+$/.test(idleRaw) ? Number(idleRaw) : undefined;
      const result = await ctx.services.workspacePower(ctx.authz!.workspace.id, idleMinutes);
      send(ctx.res, result.status, result.body);
    },
    async "admin.sleep"(ctx) {
      const body = await readJson(ctx.req) as { idleMinutes?: number; waitMs?: number };
      const result = await ctx.services.workspaceSleep(ctx.authz!.workspace.id, body);
      send(ctx.res, result.status, result.body);
    },
    async "admin.wake"(ctx) {
      const body = await readJson(ctx.req) as { healthWaitMs?: number };
      const result = await ctx.services.workspaceWake(ctx.authz!.workspace.id, body);
      send(ctx.res, result.status, result.body);
    },
    async "admin.pairing"(ctx) {
      const body = await readJson(ctx.req) as {
        label?: string;
        ttlSeconds?: number;
        member?: { email: string; role?: string };
      };
      const workspace = ctx.authz!.workspace;
      let member: { email: string; role: MembershipRole } | undefined;
      if (workspace.role === "team") {
        const email = body.member?.email?.trim().toLowerCase();
        if (!email) {
          send(ctx.res, 400, { error: "member_required" });
          return;
        }
        const account = await ctx.tenant.getAccountByEmail(email);
        if (!account) {
          send(ctx.res, 404, { error: "not_found" });
          return;
        }
        const membership = await ctx.tenant.getMembership(account.id, workspace.id);
        if (!membership) {
          send(ctx.res, 404, { error: "not_found" });
          return;
        }
        // Membership role from the store — ignore any client-supplied elevation.
        member = { email: account.email, role: membership.role };
      }
      const result = await ctx.services.workspacePairing(workspace.id, {
        label: body.label,
        ttlSeconds: body.ttlSeconds,
        member,
      });
      send(ctx.res, result.status === 200 ? 200 : result.status, result.body);
    },
    async "admin.listMembers"(ctx) {
      const rows = await ctx.tenant.listMembers(ctx.authz!.workspace.id);
      send(ctx.res, 200, { ok: true, members: rows.map(memberPublic) });
    },
    async "admin.patchMember"(ctx) {
      const accountId = ctx.params.accountId;
      const body = await readJson(ctx.req) as { role?: string };
      const nextRole = body.role as MembershipRole;
      const target = (await ctx.tenant.listMembers(ctx.authz!.workspace.id)).find((m) => m.account.id === accountId);
      if (!target) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const decision = mayChangeMemberRole({
        actorRole: ctx.authz!.membership.role,
        targetRole: target.membership.role,
        nextRole,
        targetIsSelf: accountId === ctx.authz!.account.id,
      });
      if (!decision.ok) {
        // Self-demote without transfer and owner locks → 409; others stay 404 (TC36).
        if (decision.error === "transfer_required" || decision.error === "owner_locked") {
          send(ctx.res, 409, { error: decision.error });
          return;
        }
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      if (nextRole === "owner") {
        // Explicit transfer only: promote target, demote current owner → admin (same txn semantics).
        await ctx.tenant.upsertMembership(accountId, ctx.authz!.workspace.id, "owner");
        await ctx.tenant.upsertMembership(ctx.authz!.account.id, ctx.authz!.workspace.id, "admin");
      } else {
        await ctx.tenant.upsertMembership(accountId, ctx.authz!.workspace.id, nextRole);
      }
      const updated = (await ctx.tenant.listMembers(ctx.authz!.workspace.id)).find((m) => m.account.id === accountId)!;
      send(ctx.res, 200, { ok: true, member: memberPublic(updated) });
    },
    async "admin.removeMember"(ctx) {
      const accountId = ctx.params.accountId;
      const target = (await ctx.tenant.listMembers(ctx.authz!.workspace.id)).find((m) => m.account.id === accountId);
      if (!target) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const decision = mayRemoveMember({
        actorRole: ctx.authz!.membership.role,
        targetRole: target.membership.role,
        targetIsSelf: accountId === ctx.authz!.account.id,
      });
      if (!decision.ok) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const email = target.account.email;
      await ctx.tenant.deleteMembership(accountId, ctx.authz!.workspace.id);
      const revoked = await ctx.tenant.revokeAllSessionsForAccount(accountId);
      let machine: { status: number; body: unknown } | null = null;
      if (ctx.authz!.workspace.role === "team") {
        machine = await ctx.services.workspaceMemberLeft(ctx.authz!.workspace.id, email);
      }
      send(ctx.res, 200, {
        ok: true,
        removed: true,
        accountId,
        sessionsRevoked: revoked,
        ...(machine ? { memberLeft: machine.body } : {}),
      });
    },
    async "admin.createInvite"(ctx) {
      const body = await readJson(ctx.req) as { email?: string; role?: string };
      const role = body.role === "admin" ? "admin" : body.role === "member" ? "member" : null;
      if (!role || !body.email) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      const plan = ctx.authz!.workspace.plan as PlanId;
      const result = await createWorkspaceInvite({
        tenant: ctx.tenant,
        invites: ctx.invites,
        workspaceId: ctx.authz!.workspace.id,
        plan,
        actorAccountId: ctx.authz!.account.id,
        actorRole: ctx.authz!.membership.role,
        email: body.email,
        role,
      });
      if (!result.ok) {
        send(ctx.res, result.status, { error: result.error, ...(result.code ? { code: result.code } : {}) });
        return;
      }
      send(ctx.res, 201, {
        ok: true,
        invite: {
          id: result.invite.id,
          email: result.invite.email,
          role: result.invite.role,
          expiresAt: result.invite.expiresAt,
        },
        token: result.token,
      });
    },
    async "admin.listInvites"(ctx) {
      const rows = await ctx.invites.listInvites(ctx.authz!.workspace.id);
      send(ctx.res, 200, {
        ok: true,
        invites: rows.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt,
          createdAt: i.createdAt,
        })),
      });
    },
    async "admin.revokeInvite"(ctx) {
      const inviteId = ctx.params.inviteId;
      const rows = await ctx.invites.listInvites(ctx.authz!.workspace.id);
      if (!rows.some((i) => i.id === inviteId)) {
        send(ctx.res, 404, { error: "not_found" });
        return;
      }
      await ctx.invites.revokeInvite(inviteId!);
      send(ctx.res, 200, { ok: true, revoked: true });
    },
  };
}

export const ADMIN_DISPATCH_TABLE: DispatchEntry[] = buildDispatchTable(
  ROUTE_REGISTRY,
  buildHandlers() as Record<string, (ctx: unknown) => Promise<void>>,
);

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function createAdminHandler(deps: AdminHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { services, tenant, invites, auth } = deps;
  const cookieSecure = deps.cookieSecure !== false;
  const allowFakeSignIn = deps.allowFakeSignIn ?? auth instanceof FakeAuthProvider;
  const webhooks = deps.webhooks ?? createMemoryWebhookEventStore();

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://admin.local");
      const method = (req.method ?? "GET").toUpperCase();
      const matched = matchDispatchEntry(ADMIN_DISPATCH_TABLE, method, url.pathname);
      if (!matched) {
        send(res, 404, { error: "not_found" });
        return;
      }
      const { entry, params } = matched;
      const rawBody = await readRawBody(req);
      const session = await resolveRequestSession(tenant, req);

      if (entry.auth === "session" || entry.auth === "membership") {
        if (!session) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
      }

      let authz: AuthorizeOk | null = null;
      if (entry.auth === "membership") {
        const workspaceId = params.workspaceId;
        if (!workspaceId) {
          send(res, 404, { error: "not_found" });
          return;
        }
        const result = await authorizeWorkspaceAccess({
          tenant,
          session,
          workspaceId,
          minRole: entry.minRole ?? "member",
        });
        if (!result.ok) {
          send(res, result.status, { error: result.error });
          return;
        }
        authz = result;
      }

      // Re-bind JSON reader for handlers that still call readJson — consume from buffer.
      const reqWithBody = Object.assign(req, {
        [Symbol.asyncIterator]: async function* () {
          if (rawBody.length) yield rawBody;
        },
      });

      const ctx: RouteContext = {
        req: reqWithBody,
        res,
        url,
        params,
        session,
        authz,
        services,
        tenant,
        invites,
        auth,
        cookieSecure,
        allowFakeSignIn,
        webhooks,
        rawBody,
      };
      await (entry.handler as (c: RouteContext) => Promise<void>)(ctx);
    } catch (error) {
      console.error(safeLogLine("admin-error", { message: error instanceof Error ? error.message : String(error) }));
      send(res, statusOf(error), { error: error instanceof Error ? error.message : "error" });
    }
  };
}
