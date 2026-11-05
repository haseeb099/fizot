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
  buildDispatchTable,
  matchDispatchEntry,
  ROUTE_REGISTRY,
  type DispatchEntry,
} from "./route-registry.ts";
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

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  session: SessionContext | null;
  authz: AuthorizeOk | null;
  services: AdminServices;
  tenant: TenantStore;
  auth: AuthProvider;
  cookieSecure: boolean;
  allowFakeSignIn: boolean;
};

export type AdminHandlerDeps = {
  services: AdminServices;
  tenant: TenantStore;
  auth: AuthProvider;
  /** When false, skip Secure on Set-Cookie (loopback tests). Default true. */
  cookieSecure?: boolean;
  /** Allow POST /edge/auth/fake-sign-in. */
  allowFakeSignIn?: boolean;
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
      const workspaceId = ctx.authz!.workspace.id;
      const result = await openWorkspaceSession({
        tenant: ctx.tenant,
        session: ctx.authz!.session,
        workspaceId,
        services: ctx.services,
      });
      if (!result.ok) {
        send(ctx.res, result.status, { error: result.error });
        return;
      }
      send(ctx.res, 200, result);
    },
    async "admin.createWorkspace"(ctx) {
      const body = await readJson(ctx.req) as {
        plan?: string;
        ownerEmail?: string;
        teamId?: string;
        teamName?: string;
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
        teamId: body.teamId,
        teamName: body.teamName,
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
      const workspaceId = ctx.authz!.workspace.id;
      await ctx.services.destroyWorkspace(workspaceId);
      send(ctx.res, 200, { ok: true, destroyed: true, appName: ctx.authz!.workspace.appName });
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
        member?: { email: string; role: TeamRole };
      };
      const result = await ctx.services.workspacePairing(ctx.authz!.workspace.id, body);
      send(ctx.res, result.status === 200 ? 200 : result.status, result.body);
    },
  };
}

/** Single dispatcher table: ROUTE_REGISTRY × handlers. Built once per process. */
export const ADMIN_DISPATCH_TABLE: DispatchEntry[] = buildDispatchTable(
  ROUTE_REGISTRY,
  buildHandlers() as Record<string, (ctx: unknown) => Promise<void>>,
);

/**
 * ONE HTTP dispatcher: match ROUTE_REGISTRY only, enforce auth from the entry,
 * then call that entry's handler. No route can be served without a registry row.
 */
export function createAdminHandler(deps: AdminHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { services, tenant, auth } = deps;
  const cookieSecure = deps.cookieSecure !== false;
  const allowFakeSignIn = deps.allowFakeSignIn ?? auth instanceof FakeAuthProvider;

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

      const ctx: RouteContext = {
        req,
        res,
        url,
        params,
        session,
        authz,
        services,
        tenant,
        auth,
        cookieSecure,
        allowFakeSignIn,
      };
      await (entry.handler as (c: RouteContext) => Promise<void>)(ctx);
    } catch (error) {
      console.error(safeLogLine("admin-error", { message: error instanceof Error ? error.message : String(error) }));
      send(res, statusOf(error), { error: error instanceof Error ? error.message : "error" });
    }
  };
}
