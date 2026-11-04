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
import { matchRoute } from "./route-registry.ts";
import { safeLogLine } from "./redact.ts";
import type { PlanId } from "./plans.ts";
import type { SessionContext, TenantStore } from "./tenant.ts";
import type { AdminServices } from "./workspaces.ts";
import type { TeamRole } from "../../cloud-team.ts";
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

export type AdminHandlerDeps = {
  services: AdminServices;
  tenant: TenantStore;
  auth: AuthProvider;
  /** When false, skip Secure on Set-Cookie (loopback tests). Default true. */
  cookieSecure?: boolean;
  /** Allow POST /edge/auth/fake-sign-in. Default: FakeAuthProvider only. */
  allowFakeSignIn?: boolean;
};

export function createAdminHandler(deps: AdminHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { services, tenant, auth } = deps;
  const cookieSecure = deps.cookieSecure !== false;
  const allowFakeSignIn = deps.allowFakeSignIn ?? auth instanceof FakeAuthProvider;

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://admin.local");
      const method = (req.method ?? "GET").toUpperCase();
      const matched = matchRoute(method, url.pathname);
      if (!matched) {
        send(res, 404, { error: "not_found" });
        return;
      }
      const { def, params } = matched;
      const session = await resolveRequestSession(tenant, req);

      if (def.auth === "session" || def.auth === "membership") {
        if (!session) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
      }

      if (def.auth === "membership") {
        const workspaceId = params.workspaceId;
        if (!workspaceId) {
          send(res, 404, { error: "not_found" });
          return;
        }
        const authz = await authorizeWorkspaceAccess({
          tenant,
          session,
          workspaceId,
          minRole: def.minRole ?? "member",
        });
        if (!authz.ok) {
          send(res, authz.status, { error: authz.error });
          return;
        }
        await handleMembershipRoute(def.id, req, res, { services, tenant, authz, url });
        return;
      }

      await handleSessionOrPublic(def.id, req, res, {
        services,
        tenant,
        auth,
        session,
        allowFakeSignIn,
        cookieSecure,
      });
    } catch (error) {
      console.error(safeLogLine("admin-error", { message: error instanceof Error ? error.message : String(error) }));
      send(res, statusOf(error), { error: error instanceof Error ? error.message : "error" });
    }
  };
}

async function handleMembershipRoute(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { services: AdminServices; tenant: TenantStore; authz: AuthorizeOk; url: URL },
): Promise<void> {
  const workspaceId = ctx.authz.workspace.id;
  switch (id) {
    case "admin.destroyWorkspace": {
      await ctx.services.destroyWorkspace(workspaceId);
      send(res, 200, { ok: true, destroyed: true, appName: ctx.authz.workspace.appName });
      return;
    }
    case "admin.health": {
      const result = await ctx.services.workspaceHealth(workspaceId);
      send(res, result.status, result.body);
      return;
    }
    case "admin.power": {
      const idleRaw = ctx.url.searchParams.get("idleMinutes");
      const idleMinutes = idleRaw && /^\d+$/.test(idleRaw) ? Number(idleRaw) : undefined;
      const result = await ctx.services.workspacePower(workspaceId, idleMinutes);
      send(res, result.status, result.body);
      return;
    }
    case "admin.sleep": {
      const body = await readJson(req) as { idleMinutes?: number; waitMs?: number };
      const result = await ctx.services.workspaceSleep(workspaceId, body);
      send(res, result.status, result.body);
      return;
    }
    case "admin.wake": {
      const body = await readJson(req) as { healthWaitMs?: number };
      const result = await ctx.services.workspaceWake(workspaceId, body);
      send(res, result.status, result.body);
      return;
    }
    case "admin.pairing": {
      const body = await readJson(req) as {
        label?: string;
        ttlSeconds?: number;
        member?: { email: string; role: TeamRole };
      };
      const result = await ctx.services.workspacePairing(workspaceId, body);
      send(res, result.status === 200 ? 200 : result.status, result.body);
      return;
    }
    case "edge.openWorkspace": {
      const result = await openWorkspaceSession({
        tenant: ctx.tenant,
        session: ctx.authz.session,
        workspaceId,
        services: ctx.services,
      });
      if (!result.ok) {
        send(res, result.status, { error: result.error });
        return;
      }
      send(res, 200, result);
      return;
    }
    default:
      send(res, 404, { error: "not_found" });
  }
}

async function handleSessionOrPublic(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    services: AdminServices;
    tenant: TenantStore;
    auth: AuthProvider;
    session: SessionContext | null;
    allowFakeSignIn: boolean;
    cookieSecure: boolean;
  },
): Promise<void> {
  switch (id) {
    case "edge.health": {
      send(res, 200, { ok: true, service: "fizot-edge" });
      return;
    }
    case "edge.fakeSignIn": {
      if (!ctx.allowFakeSignIn) {
        send(res, 404, { error: "not_found" });
        return;
      }
      const body = await readJson(req) as { email?: string };
      const prior = readSessionToken(req);
      const signed = await signInWithProvider({
        tenant: ctx.tenant,
        auth: ctx.auth,
        email: body.email ?? "",
        priorToken: prior,
      });
      send(res, 200, { ok: true, accountId: signed.account.id, email: signed.account.email }, {
        "set-cookie": formatSessionCookie(signed.token, { secure: ctx.cookieSecure, maxAgeSec: 7 * 24 * 3600 }),
      });
      return;
    }
    case "edge.signOut": {
      if (ctx.session) await ctx.tenant.revokeSession(ctx.session.session.id);
      send(res, 200, { ok: true }, {
        "set-cookie": formatClearSessionCookie({ secure: ctx.cookieSecure }),
      });
      return;
    }
    case "edge.me": {
      if (!ctx.session) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const rows = await ctx.tenant.listWorkspacesForAccount(ctx.session.account.id);
      send(res, 200, {
        ok: true,
        account: { id: ctx.session.account.id, email: ctx.session.account.email },
        workspaces: rows.map((r) => ({
          id: r.workspace.id,
          plan: r.workspace.plan,
          role: r.membership.role,
          publicUrl: r.workspace.publicUrl,
        })),
      });
      return;
    }
    case "admin.createWorkspace": {
      if (!ctx.session) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const body = await readJson(req) as {
        plan?: string;
        ownerEmail?: string;
        teamId?: string;
        teamName?: string;
      };
      if (body.plan !== "home" && body.plan !== "team") {
        send(res, 400, { error: "unknown_plan" });
        return;
      }
      const ownerEmail = body.ownerEmail?.trim().toLowerCase() || ctx.session.account.email;
      if (ownerEmail !== ctx.session.account.email) {
        send(res, 403, { error: "forbidden_owner" });
        return;
      }
      const record = await ctx.services.createWorkspace({
        plan: body.plan as PlanId,
        ownerEmail,
        teamId: body.teamId,
        teamName: body.teamName,
      });
      await ctx.tenant.upsertMembership(ctx.session.account.id, record.id, "owner");
      const { bootstrapSecret: _secret, ...publicRecord } = record;
      void _secret;
      send(res, 201, { ok: true, workspace: publicRecord });
      return;
    }
    case "admin.listWorkspaces": {
      if (!ctx.session) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const rows = await ctx.tenant.listWorkspacesForAccount(ctx.session.account.id);
      send(res, 200, {
        ok: true,
        workspaces: rows.map((r) => ({
          id: r.workspace.id,
          plan: r.workspace.plan,
          role: r.membership.role,
          publicUrl: r.workspace.publicUrl,
          appName: r.workspace.appName,
        })),
      });
      return;
    }
    default:
      send(res, 404, { error: "not_found" });
  }
}
