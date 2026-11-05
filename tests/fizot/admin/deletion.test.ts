import { expect, it } from "vitest";
import {
  createDeletionRunner,
  createFakeFlyClient,
  createMemoryWorkspaceStore,
  createMemoryTenantStore,
  createMemoryInviteStore,
  createAdminServices,
  createMemoryNonceStore,
  DELETION_ALERT_12H_MS,
  DELETION_FAIL_24H_MS,
  DELETION_STEPS,
  countWorkspaceRefs,
  hashWorkspaceId,
} from "../../../server/fizot/admin/public.ts";

function wrapFlyWithVolumeFailures(failTimes: number) {
  const fly = createFakeFlyClient();
  let fails = 0;
  const original = fly.destroyVolume.bind(fly);
  fly.destroyVolume = async (appName, volumeId) => {
    if (fails < failTimes) {
      fails++;
      throw new Error("Fly DELETE volume → 500: injected");
    }
    return original(appName, volumeId);
  };
  return { fly, getFails: () => fails };
}

it("deletion retries volume failure then completes; receipt has all steps; remainingCount 0", async () => {
  const { fly, getFails } = wrapFlyWithVolumeFailures(2);
  const store = createMemoryWorkspaceStore();
  const tenant = createMemoryTenantStore(store);
  const invites = createMemoryInviteStore();
  const services = createAdminServices({
    adminUrl: "https://admin.test",
    flyOrg: "fizot",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
    tenant,
    invites,
  });
  const ws = await services.createWorkspace({ plan: "home", ownerEmail: "del@example.com" });
  const account = await tenant.ensureAccount("del@example.com");
  await tenant.upsertMembership(account.id, ws.id, "owner");

  const alerts: string[] = [];
  const runner = createDeletionRunner({
    store,
    fly,
    tenant,
    invites,
    alert: async (a) => { alerts.push(a.kind); },
    backoffMs: 1,
    maxAttempts: 10,
  });

  await runner.requestDeletion(ws.id);
  const receipt = await runner.runOnce(ws.id);
  expect(getFails()).toBe(2);
  expect(receipt.status).toBe("complete");
  expect(receipt.stepsDone).toEqual([...DELETION_STEPS]);
  expect(receipt.workspaceIdHash).toBe(hashWorkspaceId(ws.id));
  expect(await fly.getApp(ws.appName)).toBeNull();
  expect(await store.get(ws.id)).toBeNull();
  const refs = await countWorkspaceRefs(store, tenant, invites, ws.id);
  expect(refs.remainingCount).toBe(0);

  // Idempotent re-run
  const again = await runner.runOnce(ws.id);
  expect(again.status).toBe("complete");
  expect(alerts).toEqual([]);
});

it("deletion alerts at 12h simulated and fails at 24h with hourly alerts", async () => {
  const fly = createFakeFlyClient();
  // Always fail volume destroy
  fly.destroyVolume = async () => {
    throw new Error("Fly DELETE volume → 500: sticky");
  };
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
  const ws = await services.createWorkspace({ plan: "home", ownerEmail: "slow@example.com" });

  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const alerts: Array<{ kind: string; message: string }> = [];
  const runner = createDeletionRunner({
    store,
    fly,
    now: () => clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    backoffMs: 0,
    alert: async (a) => { alerts.push({ kind: a.kind, message: a.message }); },
  });

  await runner.requestDeletion(ws.id);
  await runner.runOnce(ws.id); // fails on volume

  clock += DELETION_ALERT_12H_MS + 1000;
  let receipt = await runner.runOnce(ws.id);
  expect(receipt.alertedAt12h).toBeTruthy();
  expect(alerts.some((a) => a.kind === "12h")).toBe(true);
  console.log("deletion_12h_alert", alerts.filter((a) => a.kind === "12h"));

  clock += (DELETION_FAIL_24H_MS - DELETION_ALERT_12H_MS);
  receipt = await runner.runOnce(ws.id);
  expect(receipt.status).toBe("failed");
  expect(alerts.some((a) => a.kind === "24h" || a.kind === "hourly")).toBe(true);
  console.log("deletion_24h_failed", { status: receipt.status, alerts });

  const beforeHourly = alerts.length;
  clock += 60 * 60_000 + 1000;
  receipt = await runner.runOnce(ws.id);
  expect(alerts.length).toBeGreaterThan(beforeHourly);
  console.log("deletion_hourly_alert", alerts.slice(beforeHourly));
});
