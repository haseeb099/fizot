/**
 * Team membership role rules (docs/team-cloud.md).
 * Owner = paying account, exactly one; cannot be removed/demoted except by transfer.
 * Admin manages members and settings; Member only uses the workspace.
 */
import type { MembershipRole } from "./tenant.ts";

export type RoleChangeRefusal =
  | "not_found"
  | "forbidden"
  | "owner_locked"
  | "last_owner"
  | "invalid_role";

/** Whether `actor` may set `target`'s role to `next` (transfer included). */
export function mayChangeMemberRole(input: {
  actorRole: MembershipRole;
  targetRole: MembershipRole;
  nextRole: MembershipRole;
  targetIsSelf: boolean;
}): { ok: true } | { ok: false; error: RoleChangeRefusal } {
  const { actorRole, targetRole, nextRole, targetIsSelf } = input;
  if (nextRole !== "owner" && nextRole !== "admin" && nextRole !== "member") {
    return { ok: false, error: "invalid_role" };
  }
  // Demoting or removing the owner is refused except transfer (owner → promote other).
  if (targetRole === "owner" && nextRole !== "owner") {
    if (!(actorRole === "owner" && targetIsSelf && nextRole === "admin")) {
      return { ok: false, error: "owner_locked" };
    }
  }
  if (nextRole === "owner") {
    if (actorRole !== "owner") return { ok: false, error: "forbidden" };
    return { ok: true };
  }
  if (actorRole === "owner") return { ok: true };
  if (actorRole === "admin") {
    if (targetRole === "owner" || targetRole === "admin") return { ok: false, error: "forbidden" };
    if (nextRole === "admin") return { ok: false, error: "forbidden" };
    return { ok: true };
  }
  return { ok: false, error: "forbidden" };
}

export function mayRemoveMember(input: {
  actorRole: MembershipRole;
  targetRole: MembershipRole;
  targetIsSelf: boolean;
}): { ok: true } | { ok: false; error: RoleChangeRefusal } {
  if (input.targetRole === "owner") return { ok: false, error: "owner_locked" };
  if (input.actorRole === "owner") return { ok: true };
  if (input.actorRole === "admin") {
    if (input.targetRole === "admin" && !input.targetIsSelf) return { ok: false, error: "forbidden" };
    return { ok: true };
  }
  if (input.actorRole === "member" && input.targetIsSelf) return { ok: true };
  return { ok: false, error: "forbidden" };
}

/** Who may invite a given role. Owner invites admins; admin+ invites members. */
export function mayInviteRole(actorRole: MembershipRole, inviteRole: "admin" | "member"): boolean {
  if (inviteRole === "admin") return actorRole === "owner";
  return actorRole === "owner" || actorRole === "admin";
}
