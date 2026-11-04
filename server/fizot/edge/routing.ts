/**
 * Edge routing: session → membership → signed cloud-home pairing on the machine.
 * Never trusts a client-supplied workspace id without authorizeWorkspaceAccess.
 */
import type { AdminServices } from "../admin/workspaces.ts";
import { authorizeWorkspaceAccess } from "../admin/authorize.ts";
import type { SessionContext, TenantStore } from "../admin/tenant.ts";

export type OpenWorkspaceSessionResult = {
  ok: true;
  workspaceId: string;
  pairingLink: string;
  role: string;
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
}): Promise<OpenWorkspaceSessionResult> {
  const authz = await authorizeWorkspaceAccess({
    tenant: input.tenant,
    session: input.session,
    workspaceId: input.workspaceId,
    minRole: "member",
  });
  if (!authz.ok) return { ok: false, status: authz.status, error: authz.error };

  try {
    const pairing = await input.services.workspacePairing(authz.workspace.id, {
      label: input.label ?? "Fizot edge",
      ttlSeconds: 120,
    });
    if (pairing.status !== 200 || typeof pairing.body.pairingLink !== "string") {
      return { ok: false, status: 502, error: "pairing_failed" };
    }
    return {
      ok: true,
      workspaceId: authz.workspace.id,
      pairingLink: pairing.body.pairingLink,
      role: authz.membership.role,
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "pairing_failed",
    };
  }
}
