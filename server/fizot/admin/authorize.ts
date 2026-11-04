/**
 * Object-level authorisation for every Admin and Edge endpoint that names a workspace.
 * Unknown and forbidden both return 404 — no existence leak.
 */
import type { IncomingMessage } from "node:http";
import { resolveRequestSession } from "./auth.ts";
import type { AccountRecord, MembershipRecord, MembershipRole, SessionContext, TenantStore } from "./tenant.ts";
import { roleAtLeast } from "./tenant.ts";
import type { WorkspaceRecord } from "./store.ts";

export type AuthorizeOk = {
  ok: true;
  session: SessionContext;
  account: AccountRecord;
  membership: MembershipRecord;
  workspace: WorkspaceRecord;
};

export type AuthorizeFail = {
  ok: false;
  /** 401 when no session; 404 when missing membership or workspace (same for both). */
  status: 401 | 404;
  error: "unauthorized" | "not_found";
};

export type AuthorizeResult = AuthorizeOk | AuthorizeFail;

/**
 * One function for every workspace-scoped Admin/Edge route.
 * Callers must not load a workspace by id without going through this helper
 * (or TenantStore.getWorkspaceForMember / listWorkspacesForAccount).
 */
export async function authorizeWorkspaceAccess(input: {
  tenant: TenantStore;
  session: SessionContext | null;
  workspaceId: string;
  minRole?: MembershipRole;
}): Promise<AuthorizeResult> {
  if (!input.session) return { ok: false, status: 401, error: "unauthorized" };
  const hit = await input.tenant.getWorkspaceForMember(input.session.account.id, input.workspaceId);
  if (!hit) return { ok: false, status: 404, error: "not_found" };
  if (input.minRole && !roleAtLeast(hit.membership.role, input.minRole)) {
    return { ok: false, status: 404, error: "not_found" };
  }
  return {
    ok: true,
    session: input.session,
    account: input.session.account,
    membership: hit.membership,
    workspace: hit.workspace,
  };
}

export async function authorizeWorkspaceFromRequest(input: {
  tenant: TenantStore;
  req: IncomingMessage;
  workspaceId: string;
  minRole?: MembershipRole;
}): Promise<AuthorizeResult> {
  const session = await resolveRequestSession(input.tenant, input.req);
  return authorizeWorkspaceAccess({
    tenant: input.tenant,
    session,
    workspaceId: input.workspaceId,
    minRole: input.minRole,
  });
}

/** Marker used by TC36: every protected route handler must call through a function tagged with this. */
export const AUTHORIZE_HELPER_ID = "fizot.authorizeWorkspaceAccess" as const;

Object.defineProperty(authorizeWorkspaceAccess, "helperId", {
  value: AUTHORIZE_HELPER_ID,
  enumerable: false,
});
