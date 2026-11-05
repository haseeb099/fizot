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

it("projects daily cost from published Fly rates for shared-cpu-1x 2GB", () => {
  const p = projectDailyCost({ volumeGb: 10, memoryMb: 2048 });
  // $12.70/mo machine + $1.50/mo volume (Fly pricing page, read via cost-sheet).
  expect(p.machineUsdPerDay).toBe(0.4233);
  expect(p.volumeUsdPerDay).toBe(0.05);
  expect(p.monthlyUsdAtAlwaysOn).toBe(14.2);
  expect(p.totalGbpPerDay).toBeGreaterThan(0);
  expect(formatCostProjection(p)).toContain("projected daily cost");
  expect(formatCostProjection(p)).toContain("12.7");
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
  const receipt = await services.runDeletionJob(workspace.id);
  expect(receipt.status).toBe("complete");
  expect(fly.calls.some((c) => c === `destroyApp:${workspace.appName}`)).toBe(true);
  expect(fly.apps.has(workspace.appName)).toBe(false);
  expect(await store.get(workspace.id)).toBeNull();
});
