import { expect, it } from "vitest";
import {
  createAdminServices,
  createDeletionRunner,
  createDeletionWorker,
  createFakeFlyClient,
  createMemoryNonceStore,
  createMemoryWorkspaceStore,
  DELETION_STEPS,
} from "../../../server/fizot/admin/public.ts";
import { createAdminServer, FakeAuthProvider } from "../../../server/fizot/admin/index.ts";

it("resumes a deletion abandoned after the volume step on a new server instance", async () => {
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
    deletionWorkerId: "worker-a",
  });
  const ws = await services.createWorkspace({ plan: "home", ownerEmail: "crash@example.com" });
  await services.deletionRunner.requestDeletion(ws.id);

  // Simulate crash after volume: mark machines+volume done, leave pending/running.
  const mid = await store.getDeletionReceipt(ws.id);
  expect(mid).toBeTruthy();
  await store.upsertDeletionReceipt({
    ...mid!,
    status: "running",
    stepsDone: ["machines", "volume"],
    leaseOwner: null,
    leaseUntil: null,
  });
  // Abandon runner A — do not call runOnce further.

  const resumed = createAdminServices({
    adminUrl: "https://admin.test",
    flyOrg: "fizot",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
    deletionWorkerId: "worker-b",
  });
  const receipt = await resumed.deletionRunner.processQueue();
  expect(receipt[0]?.status).toBe("complete");
  expect(receipt[0]?.stepsDone).toEqual([...DELETION_STEPS]);
  expect(await fly.getApp(ws.appName)).toBeNull();
  expect(await store.get(ws.id)).toBeNull();
});

it("worker retries on its own after runOnce failures without a new HTTP DELETE", async () => {
  const fly = createFakeFlyClient();
  let volumeFails = 3;
  const original = fly.destroyVolume.bind(fly);
  fly.destroyVolume = async (app, id) => {
    if (volumeFails > 0) {
      volumeFails--;
      throw new Error("Fly DELETE volume → 500: injected");
    }
    return original(app, id);
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
    deletionWorkerId: "worker-retry",
  });
  // Limit per-tick attempts so first ticks yield incomplete.
  const runner = createDeletionRunner({
    store,
    fly,
    now: Date.now,
    maxAttempts: 1,
    backoffMs: 0,
    workerId: "worker-retry",
  });
  const ws = await services.createWorkspace({ plan: "home", ownerEmail: "retry@example.com" });
  await runner.requestDeletion(ws.id);

  const worker = createDeletionWorker({
    runner,
    intervalMs: 20,
    enabled: true,
  });
  try {
    const deadline = Date.now() + 5_000;
    let receipt = await store.getDeletionReceipt(ws.id);
    while (Date.now() < deadline && receipt?.status !== "complete") {
      await new Promise((r) => setTimeout(r, 30));
      receipt = await store.getDeletionReceipt(ws.id);
    }
    expect(receipt?.status).toBe("complete");
    expect(volumeFails).toBe(0);
  } finally {
    worker.stop();
  }
});

it("createAdminServer starts a deletion worker when explicitly enabled in test", async () => {
  const admin = await createAdminServer({
    fly: createFakeFlyClient(),
    auth: new FakeAuthProvider(),
    cookieSecure: false,
    enableDeletionWorker: true,
    deletionWorkerIntervalMs: 60_000,
  });
  try {
    expect(admin.deletionWorker?.running).toBe(true);
  } finally {
    await admin.close();
    expect(admin.deletionWorker?.running).toBe(false);
  }
});

it("createAdminServer does not start deletion worker by default under NODE_ENV=test", async () => {
  expect(process.env.NODE_ENV).toBe("test");
  const admin = await createAdminServer({
    fly: createFakeFlyClient(),
    auth: new FakeAuthProvider(),
    cookieSecure: false,
  });
  try {
    expect(admin.deletionWorker).toBeNull();
  } finally {
    await admin.close();
  }
});
