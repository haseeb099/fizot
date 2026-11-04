/**
 * Canonical Admin + Edge route table. Handlers are built from this list;
 * TC36 fails if a route is missing auth coverage or is registered outside it.
 */
export type RouteAuth =
  /** No session required (explicit public allow-list only). */
  | "public"
  /** Valid session cookie required; no workspace id. */
  | "session"
  /** Session + membership for :workspaceId (via authorizeWorkspaceAccess). */
  | "membership";

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

  // Admin — session / membership
  { id: "admin.createWorkspace", method: "POST", path: "/admin/workspaces", auth: "session", surface: "admin" },
  { id: "admin.listWorkspaces", method: "GET", path: "/admin/workspaces", auth: "session", surface: "admin" },
  { id: "admin.destroyWorkspace", method: "DELETE", path: "/admin/workspaces/:workspaceId", auth: "membership", minRole: "owner", surface: "admin" },
  { id: "admin.health", method: "GET", path: "/admin/workspaces/:workspaceId/health", auth: "membership", minRole: "member", surface: "admin" },
  { id: "admin.power", method: "GET", path: "/admin/workspaces/:workspaceId/power", auth: "membership", minRole: "member", surface: "admin" },
  { id: "admin.sleep", method: "POST", path: "/admin/workspaces/:workspaceId/sleep", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.wake", method: "POST", path: "/admin/workspaces/:workspaceId/wake", auth: "membership", minRole: "admin", surface: "admin" },
  { id: "admin.pairing", method: "POST", path: "/admin/workspaces/:workspaceId/pairing", auth: "membership", minRole: "admin", surface: "admin" },
] as const;

export function publicRouteIds(): string[] {
  return ROUTE_REGISTRY.filter((r) => r.auth === "public").map((r) => r.id);
}

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
