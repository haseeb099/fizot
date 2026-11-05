/**
 * Edge routing: session → membership → signed cloud-home pairing on the machine.
 * Never trusts a client-supplied workspace id or role without authorizeWorkspaceAccess.
 */
import type { AdminServices } from "../admin/workspaces.ts";
import { authorizeWorkspaceAccess } from "../admin/authorize.ts";
import type { SessionContext, TenantStore } from "../admin/tenant.ts";

export type OpenWorkspaceSessionResult = {
  ok: true;
  workspaceId: string;
  pairingLink: string;
  role: string;
  scopes?: string[];
} | {
  ok: false;
  status: 401 | 404 | 502;
  error: string;
};

export async function openWorkspaceSession(input: {
  tenant: TenantStore;
  session: SessionContext | null;
  workspaceId: string;
  services: AdminServices;
  label?: string;
  /** Ignored for Team workspaces — membership role from the store is authoritative. */
  requestedRole?: string;
}): Promise<OpenWorkspaceSessionResult> {
  const authz = await authorizeWorkspaceAccess({
    tenant: input.tenant,
    session: input.session,
    workspaceId: input.workspaceId,
    minRole: "member",
  });
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error };

  try {
    const member =
      authz.workspace.role === "team"
        ? { email: authz.account.email, role: authz.membership.role }
        : undefined;
    const pairing = await input.services.workspacePairing(authz.workspace.id, {
      label: input.label ?? (authz.workspace.role === "team" ? "Fizot edge (Team)" : "Fizot edge"),
      ttlSeconds: 120,
      member,
    });
    if (pairing.status !== 200 || typeof pairing.body.pairingLink !== "string") {
      return { ok: false, status: 502, error: "pairing_failed" };
    }
    return {
      ok: true,
      workspaceId: authz.workspace.id,
      pairingLink: pairing.body.pairingLink,
      role: authz.membership.role,
      ...(Array.isArray(pairing.body.scopes) ? { scopes: pairing.body.scopes as string[] } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "pairing_failed",
    };
  }
}
