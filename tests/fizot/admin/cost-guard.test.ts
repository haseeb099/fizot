import { expect, it } from "vitest";
import {
  assertMachineBudget,
  CostGuardError,
  MAX_STAGING_MACHINES,
  MAX_PROBE_MACHINE_SECONDS,
  formatCostProjection,
  projectDailyCost,
} from "../../../server/fizot/admin/public.ts";
import { createFakeFlyClient } from "../../../server/fizot/admin/public.ts";
import { createAdminServices } from "../../../server/fizot/admin/public.ts";
import { createMemoryNonceStore, createMemoryWorkspaceStore } from "../../../server/fizot/admin/public.ts";

it("projects daily cost from published Fly rates", () => {
  const p = projectDailyCost({ volumeGb: 10 });
  expect(p.machineUsdPerDay).toBeGreaterThan(0);
  expect(p.volumeUsdPerDay).toBeGreaterThan(0);
  expect(p.totalGbpPerDay).toBeGreaterThan(0);
  expect(formatCostProjection(p)).toContain("projected daily cost");
});

it("refuses a third live staging machine", () => {
  expect(() => assertMachineBudget(MAX_STAGING_MACHINES)).toThrow(CostGuardError);
  expect(assertMachineBudget(0).totalUsdPerDay).toBeGreaterThan(0);
});

it("caps probe machine time at one hour", () => {
  expect(MAX_PROBE_MACHINE_SECONDS).toBe(3600);
});

it("createMachine prints cost and refuses a third fake machine", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  const services = createAdminServices({
    adminUrl: "https://admin.example.invalid",
    flyOrg: "fizot-test",
    flyRegion: "lhr",
    machineImage: "registry.fly.io/fizot-home:test",
    fly,
    store,
    nonces: createMemoryNonceStore(),
  });
  await services.createWorkspace({ plan: "home", ownerEmail: "a@b.co" });
  await services.createWorkspace({ plan: "home", ownerEmail: "c@d.co" });
  await expect(services.createWorkspace({ plan: "home", ownerEmail: "e@f.co" })).rejects.toThrow(/cost guard/);
});

it("destroys the Fly app and drops the store row", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  const services = createAdminServices({
    adminUrl: "https://admin.example.invalid",
    flyOrg: "fizot-test",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
  });
  const workspace = await services.createWorkspace({ plan: "home", ownerEmail: "a@b.co" });
  expect(fly.apps.has(workspace.appName)).toBe(true);
  await services.destroyWorkspace(workspace.id);
  expect(fly.calls.at(-1)).toBe(`destroyApp:${workspace.appName}`);
  expect(fly.apps.has(workspace.appName)).toBe(false);
  expect(await store.get(workspace.id)).toBeNull();
});
