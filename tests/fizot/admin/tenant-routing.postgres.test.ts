import { expect, it } from "vitest";
import { createPostgresWorkspaceStore } from "../../../server/fizot/admin/store.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL;

it.skipIf(!databaseUrl)("routes tenants on a real Postgres database (AD-I)", async () => {
  const store = await createPostgresWorkspaceStore(databaseUrl!);
  const home = await store.create({
    id: `ws-home-${Date.now()}`,
    plan: "home",
    appName: `fizot-home-${Date.now()}`,
    network: "net-home",
    machineId: "cm-home",
    flyMachineId: "mach-home",
    flyVolumeId: "vol-home",
    publicUrl: "https://home.example.invalid",
    role: "home",
    bootstrapSecret: "b".repeat(43),
    createdAt: new Date().toISOString(),
    ownerEmail: "alice@example.com",
  });
  const team = await store.create({
    id: `ws-team-${Date.now()}`,
    plan: "team",
    appName: `fizot-team-${Date.now()}`,
    network: "net-team",
    machineId: "cm-team",
    flyMachineId: "mach-team",
    flyVolumeId: "vol-team",
    publicUrl: "https://team.example.invalid",
    role: "team",
    bootstrapSecret: "c".repeat(43),
    createdAt: new Date().toISOString(),
    teamId: "team-acme",
    teamName: "Acme",
  });

  expect(await store.listByOwner("alice@example.com")).toEqual([expect.objectContaining({ id: home.id })]);
  expect(await store.listByTenant("team-acme")).toEqual([expect.objectContaining({ id: team.id })]);
  expect(await store.listByOwner("alice@example.com")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: team.id })]),
  );
  await store.close();
});
