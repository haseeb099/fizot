/**
 * Team membership role rules (docs/team-cloud.md).
 * Owner = paying account, exactly one; cannot be removed or demoted except by
 * explicit ownership transfer (promote another member to owner; old owner → admin).
 * Admin manages members and settings; Member only uses the workspace.
 */
import type { MembershipRole } from "./tenant.ts";

export type RoleChangeRefusal =
  | "not_found"
  | "forbidden"
  | "owner_locked"
  | "last_owner"
  | "invalid_role"
  | "transfer_required";

/**
 * Ownership changes ONLY by transfer: actor (owner) promotes another member to
 * owner. Self-demote without transfer is refused so a workspace never loses its
 * sole owner.
 */
export function mayTransferOwnership(input: {
  actorRole: MembershipRole;
  targetRole: MembershipRole;
  targetIsSelf: boolean;
}): { ok: true } | { ok: false; error: RoleChangeRefusal } {
  if (input.actorRole !== "owner") return { ok: false, error: "forbidden" };
  if (input.targetIsSelf) return { ok: false, error: "transfer_required" };
  if (input.targetRole === "owner") return { ok: false, error: "owner_locked" };
  return { ok: true };
}

/** Whether `actor` may set `target`'s role to `next` (non-transfer role changes). */
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
  // Promoting to owner is transfer — handled by mayTransferOwnership + caller.
  if (nextRole === "owner") {
    return mayTransferOwnership({ actorRole, targetRole, targetIsSelf });
  }
  // Owner cannot demote themselves (or anyone who is owner) without transfer.
  if (targetRole === "owner") {
    return { ok: false, error: "owner_locked" };
  }
  if (actorRole === "owner") return { ok: true };
  if (actorRole === "admin") {
    if (targetRole === "admin") return { ok: false, error: "forbidden" };
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
