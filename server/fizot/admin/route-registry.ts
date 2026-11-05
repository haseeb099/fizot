/**
 * Canonical Admin + Edge route table. The HTTP dispatcher serves only these
 * entries; a route cannot exist without an auth level and a registered handler.
 */
export type RouteAuth =
  /** No session required (explicit public allow-list only). */
  | "public"
  /** Valid session cookie required; no workspace id. */
  | "session"
  /** Session + membership for :workspaceId (via authorizeWorkspaceAccess). */
  | "membership";

export const ROUTE_AUTH_LEVELS: readonly RouteAuth[] = ["public", "session", "membership"] as const;

export type RouteDef = {
  id: string;
  method: "GET" | "POST" | "DELETE";
  /** Path pattern with :workspaceId where applicable. */
  path: string;
  auth: RouteAuth;
  /** Minimum membership role when auth === "membership". */
  minRole?: "owner" | "admin" | "member";
  surface: "admin" | "edge";
};

export const ROUTE_REGISTRY: readonly RouteDef[] = [
  // Edge — public allow-list
  { id: "edge.health", method: "GET", path: "/edge/health", auth: "public", surface: "edge" },
  { id: "edge.fakeSignIn", method: "POST", path: "/edge/auth/fake-sign-in", auth: "public", surface: "edge" },
  { id: "edge.signOut", method: "POST", path: "/edge/auth/sign-out", auth: "session", surface: "edge" },
  { id: "edge.me", method: "GET", path: "/edge/me", auth: "session", surface: "edge" },
  { id: "edge.openWorkspace", method: "POST", path: "/edge/workspaces/:workspaceId/open", auth: "membership", minRole: "member", surface: "edge" },
  { id: "edge.acceptInvite", method: "POST", path: "/edge/invites/:token/accept", auth: "session", surface: "edge" },

  // Admin — session / membership
  { id: "admin.createWorkspace", method: "POST", path: "/admin/workspaces", auth: "session", surface: "admin" },
  { id: "admin.listWorkspaces", method: "GET", path: "/admin/workspaces", auth: "session", surface: "admin" },
  { id: "admin.destroyWorkspace", method: "DELETE", path: "/admin/workspaces/:workspaceId", auth: "membership", minRole: "owner", surface: "admin" },
  /** Membership while deleting; after rows are gone the handler serves the receipt to any session that knows the id (hash only, no PII). */
  { id: "admin.deletionReceipt", method: "GET", path: "/admin/workspaces/:workspaceId/deletion", auth: "session", surface: "admin" },
  { id: "admin.eraseAccount", method: "DELETE", path: "/admin/account", auth: "session", surface: "admin" },
  /** Public allow-list: signature verified inside the handler (never skip). */
  { id: "admin.webhook", method: "POST", path: "/admin/webhooks/:provider", auth: "public", surface: "admin" },
  { id: "admin.health", method: "GET", path: "/admin/workspaces/:workspaceId/health", auth: "membership", minRole: "member", surface: "admin" },
  { id: "admin.power", method: "GET", path: "/admin/workspaces/:workspaceId/power", auth: "membership", minRole: "member", surface: "admin" },
  { id: "admin.sleep", method: "POST", path: "/admin/workspaces/:workspaceId/sleep", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.wake", method: "POST", path: "/admin/workspaces/:workspaceId/wake", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.pairing", method: "POST", path: "/admin/workspaces/:workspaceId/pairing", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.listMembers", method: "GET", path: "/admin/workspaces/:workspaceId/members", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.patchMember", method: "POST", path: "/admin/workspaces/:workspaceId/members/:accountId", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.removeMember", method: "DELETE", path: "/admin/workspaces/:workspaceId/members/:accountId", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.createInvite", method: "POST", path: "/admin/workspaces/:workspaceId/invites", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.listInvites", method: "GET", path: "/admin/workspaces/:workspaceId/invites", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.revokeInvite", method: "DELETE", path: "/admin/workspaces/:workspaceId/invites/:inviteId", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.credit", method: "GET", path: "/admin/workspaces/:workspaceId/credit", auth: "membership", minRole: "member", surface: "admin" },
  /** Platform service secret, not a workspace role. Handler rejects a missing secret. */
  { id: "admin.creditGrant", method: "POST", path: "/admin/workspaces/:workspaceId/credit/grants", auth: "public", surface: "admin" },
  { id: "admin.proxyToken", method: "POST", path: "/admin/workspaces/:workspaceId/proxy-token", auth: "membership", minRole: "admin", surface: "admin" },
  /** Platform service secret. Stops provider traffic on the shared credit store. */
  { id: "admin.proxyKill", method: "POST", path: "/admin/proxy/kill", auth: "public", surface: "admin" },
] as const;

export function publicRouteIds(): string[] {
  return ROUTE_REGISTRY.filter((r) => r.auth === "public").map((r) => r.id);
}

/** Fail closed: every route must declare a known auth level. */
export function assertRouteHasAuth(route: { id?: string; auth?: unknown }): asserts route is { auth: RouteAuth } {
  if (route.auth !== "public" && route.auth !== "session" && route.auth !== "membership") {
    throw new Error(`route ${route.id ?? "<unknown>"} missing auth level`);
  }
}

export type DispatchEntry = RouteDef & {
  handler: (ctx: unknown) => Promise<void>;
};

/**
 * Bind handlers to the registry. Every registry id needs a handler; every
 * handler id must appear in the registry; every route must have an auth level.
 * The HTTP server dispatches only through the returned table.
 */
export function buildDispatchTable(
  defs: readonly RouteDef[],
  handlers: Record<string, (ctx: unknown) => Promise<void>>,
): DispatchEntry[] {
  for (const def of defs) {
    assertRouteHasAuth(def);
    if (def.auth === "membership" && !def.path.includes(":workspaceId")) {
      throw new Error(`membership route ${def.id} must include :workspaceId`);
    }
    if (typeof handlers[def.id] !== "function") {
      throw new Error(`route ${def.id} has no handler`);
    }
  }
  const registryIds = new Set(defs.map((d) => d.id));
  for (const id of Object.keys(handlers)) {
    if (!registryIds.has(id)) {
      throw new Error(`handler ${id} is not in ROUTE_REGISTRY`);
    }
  }
  return defs.map((def) => ({ ...def, handler: handlers[def.id]! }));
}

export function matchDispatchEntry(
  table: readonly DispatchEntry[],
  method: string,
  pathname: string,
): { entry: DispatchEntry; params: Record<string, string> } | null {
  const m = method.toUpperCase();
  for (const entry of table) {
    if (entry.method !== m) continue;
    const params = matchPath(entry.path, pathname);
    if (params) return { entry, params };
  }
  return null;
}

/** @deprecated Prefer matchDispatchEntry on the built table. Kept for tests that only need path matching. */
export function matchRoute(method: string, pathname: string): { def: RouteDef; params: Record<string, string> } | null {
  const m = method.toUpperCase();
  for (const def of ROUTE_REGISTRY) {
    if (def.method !== m) continue;
    const params = matchPath(def.path, pathname);
    if (params) return { def, params };
  }
  return null;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const vp = pathParts[i]!;
    if (pp.startsWith(":")) params[pp.slice(1)] = decodeURIComponent(vp);
    else if (pp !== vp) return null;
  }
  return params;
}
