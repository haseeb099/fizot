import { expect, it } from "vitest";
import {
  createMemoryTenantStore,
  createMemoryWorkspaceStore,
  roleAtLeast,
} from "../../../server/fizot/admin/public.ts";

it("role ranks: owner > admin > member", () => {
  expect(roleAtLeast("owner", "admin")).toBe(true);
  expect(roleAtLeast("admin", "member")).toBe(true);
  expect(roleAtLeast("member", "admin")).toBe(false);
  expect(roleAtLeast("admin", "owner")).toBe(false);
});

it("getWorkspaceForMember requires membership in the same lookup", async () => {
  const workspaces = createMemoryWorkspaceStore();
  const tenant = createMemoryTenantStore(workspaces);
  const ws = await workspaces.create({
    id: "ws-a",
    plan: "home",
    appName: "fizot-cm-a",
    network: "net-a",
    machineId: "cm-a",
    flyMachineId: "mach-a",
    flyVolumeId: "vol-a",
    publicUrl: "https://a.example.invalid",
    role: "home",
    bootstrapSecret: "b".repeat(43),
    createdAt: new Date().toISOString(),
    ownerEmail: "a@example.com",
  });
  const alice = await tenant.createAccount("alice@example.com");
  const bob = await tenant.createAccount("bob@example.com");
  await tenant.upsertMembership(alice.id, ws.id, "owner");

  expect(await tenant.getWorkspaceForMember(alice.id, ws.id)).toMatchObject({
    workspace: { id: ws.id },
    membership: { role: "owner" },
  });
  expect(await tenant.getWorkspaceForMember(bob.id, ws.id)).toBeNull();
  expect(await tenant.getWorkspaceForMember(alice.id, "missing")).toBeNull();
  expect(await tenant.listWorkspacesForAccount(bob.id)).toEqual([]);
  expect(await tenant.listWorkspacesForAccount(alice.id)).toHaveLength(1);
});

it("sessions resolve, revoke, and rotate", async () => {
  const workspaces = createMemoryWorkspaceStore();
  const tenant = createMemoryTenantStore(workspaces);
  const account = await tenant.createAccount("sess@example.com");
  const minted = await tenant.createSession(account.id, { ttlMs: 60_000 });
  const resolved = await tenant.resolveSession(minted.token);
  expect(resolved?.account.id).toBe(account.id);

  const rotated = await tenant.rotateSession(minted.token);
  expect(rotated).not.toBeNull();
  expect(await tenant.resolveSession(minted.token)).toBeNull();
  const afterRotate = await tenant.resolveSession(rotated!.token);
  expect(afterRotate?.account.id).toBe(account.id);

  await tenant.revokeSession(rotated!.session.id);
  expect(await tenant.resolveSession(rotated!.token)).toBeNull();
});
