import { expect, it } from "vitest";
import {
  createFakeFlyClient,
  createMemoryWorkspaceStore,
  createAdminServices,
  createMemoryNonceStore,
  reconcileWorkspaces,
  ORPHAN_REPORT_AGE_MS,
} from "../../../server/fizot/admin/public.ts";

it("reconciler flags crash mid-creation (volume without machine) and reports orphans >1h without deleting", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  const services = createAdminServices({
    adminUrl: "https://admin.test",
    flyOrg: "fizot",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
  });

  // Mid-create crash simulation: create app+volume, stop before machine, leave state=creating.
  const ws = await services.createWorkspace({ plan: "home", ownerEmail: "rec@example.com" });
  // Force creating + strip machine to simulate crash between volume and machine.
  await store.update(ws.id, { flyMachineId: "", state: "creating", stateReason: "crash_sim" });
  // Remove machine from fake fly, keep volume+app.
  for (const key of fly.machines.keys()) {
    if (key.startsWith(`${ws.appName}/`)) fly.machines.delete(key);
  }

  const report = await reconcileWorkspaces({ store, fly, org: "fizot" });
  expect(report.drifted.some((d) => d.workspaceId === ws.id && d.reason === "volume_without_machine")).toBe(true);
  const after = await store.get(ws.id);
  expect(after?.state).toBe("failed");

  // Orphan app with no workspace row
  await fly.createApp({ appName: "fizot-cm-orphan0001", org: "fizot", network: "net-orphan" });
  await store.delete(ws.id);
  const orphans = await reconcileWorkspaces({ store, fly, org: "fizot" });
  expect(orphans.orphans.some((o) => o.appName === "fizot-cm-orphan0001")).toBe(true);
  expect(orphans.orphans.every((o) => o.ageMs >= ORPHAN_REPORT_AGE_MS)).toBe(true);
  // Must NOT auto-delete
  expect(await fly.getApp("fizot-cm-orphan0001")).not.toBeNull();
});

it("idempotent create: same requestId never makes a second Fly app", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  const services = createAdminServices({
    adminUrl: "https://admin.test",
    flyOrg: "fizot",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
  });
  const a = await services.createWorkspace({
    plan: "home",
    ownerEmail: "idem@example.com",
    requestId: "req-idem-1",
  });
  const b = await services.createWorkspace({
    plan: "home",
    ownerEmail: "idem@example.com",
    requestId: "req-idem-1",
  });
  expect(b.id).toBe(a.id);
  expect(fly.calls.filter((c) => c.startsWith("createApp:")).length).toBe(1);
});
