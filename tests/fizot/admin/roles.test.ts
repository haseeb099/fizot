import { expect, it } from "vitest";
import { mayChangeMemberRole, mayInviteRole, mayRemoveMember } from "../../../server/fizot/admin/public.ts";
import { seatMaxForPlan, planFlags } from "../../../server/fizot/admin/public.ts";

it("plan seats: home=1 team=5", () => {
  expect(seatMaxForPlan("home")).toBe(1);
  expect(seatMaxForPlan("team")).toBe(5);
  expect(planFlags("team")?.sleepAllowed).toBe(false);
});

it("role matrix: owner locked; admin manages members; member cannot elevate", () => {
  expect(mayRemoveMember({ actorRole: "owner", targetRole: "owner", targetIsSelf: false }).ok).toBe(false);
  expect(mayRemoveMember({ actorRole: "admin", targetRole: "member", targetIsSelf: false }).ok).toBe(true);
  expect(mayRemoveMember({ actorRole: "admin", targetRole: "admin", targetIsSelf: false }).ok).toBe(false);
  expect(mayChangeMemberRole({
    actorRole: "admin", targetRole: "member", nextRole: "admin", targetIsSelf: false,
  }).ok).toBe(false);
  expect(mayChangeMemberRole({
    actorRole: "owner", targetRole: "member", nextRole: "admin", targetIsSelf: false,
  }).ok).toBe(true);
  expect(mayChangeMemberRole({
    actorRole: "owner", targetRole: "member", nextRole: "owner", targetIsSelf: false,
  }).ok).toBe(true);
  expect(mayInviteRole("admin", "admin")).toBe(false);
  expect(mayInviteRole("owner", "admin")).toBe(true);
  expect(mayInviteRole("admin", "member")).toBe(true);
  expect(mayInviteRole("member", "member")).toBe(false);
});
