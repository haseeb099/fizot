/**
 * AD-I: state machine, deletion receipt, webhook dedupe, leases on real Postgres.
 * Runs only when ADMIN_DATABASE_URL is set (admin-postgres.yml).
 */
import { expect, it } from "vitest";
import {
  countWorkspaceRefs,
  createDeletionRunner,
  createFakeFlyClient,
  createPostgresWebhookEventStore,
  createPostgresWorkspaceStore,
  DELETION_STEPS,
  deliverWebhookEvent,
  mayTransition,
} from "../../../server/fizot/admin/public.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL?.trim() ?? "";

async function seedWorkspace(store: Awaited<ReturnType<typeof createPostgresWorkspaceStore>>, suffix: string) {
  const id = `pg-life-${suffix}-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const appName = `fizot-cm-${id.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase()}`;
  await store.create({
    id,
    plan: "home",
    appName,
    network: `net-${id}`,
    machineId: `cm-${id.slice(-8)}`,
    flyMachineId: "mach_pg",
    flyVolumeId: "vol_pg",
    publicUrl: "https://example.invalid",
    role: "home",
    bootstrapSecret: "secret",
    createdAt,
    requestId: `req-${id}`,
    state: "requested",
    stateChangedAt: createdAt,
    stateReason: "test",
    ownerEmail: "pg@example.com",
  });
  await store.transition(id, "creating", "start");
  await store.transition(id, "ready", "done");
  return { id, appName };
}

it.runIf(Boolean(databaseUrl))("Postgres: transitions + deletion receipt + webhook unique under concurrency", async () => {
  const store = await createPostgresWorkspaceStore(databaseUrl);
  const webhooks = await createPostgresWebhookEventStore(databaseUrl);
  const fly = createFakeFlyClient();
  try {
    const { id, appName } = await seedWorkspace(store, "basic");
    expect(mayTransition("requested", "creating")).toBe(true);
    const transitions = await store.listTransitions(id);
    expect(transitions.map((t) => t.toState)).toEqual(["requested", "creating", "ready"]);

    await fly.createApp({ appName, org: "fizot", network: `net-${id}` });
    const runner = createDeletionRunner({
      store,
      fly,
      backoffMs: 1,
      maxAttempts: 5,
    });
    await runner.requestDeletion(id);
    const receipt = await runner.runOnce(id);
    expect(receipt.status).toBe("complete");
    expect(await store.getDeletionReceipt(id)).toMatchObject({ status: "complete" });
    expect(await store.get(id)).toBeNull();
    expect(await store.listTransitions(id)).toHaveLength(0);
    const refs = await countWorkspaceRefs(store, undefined, undefined, id);
    expect(refs.remainingCount).toBe(0);

    let runs = 0;
    const [a, b] = await Promise.all([
      deliverWebhookEvent({
        store: webhooks,
        provider: "generic",
        eventId: `evt-pg-${id}`,
        handler: async () => { runs += 1; return true; },
      }),
      deliverWebhookEvent({
        store: webhooks,
        provider: "generic",
        eventId: `evt-pg-${id}`,
        handler: async () => { runs += 1; return true; },
      }),
    ]);
    expect([a, b].filter((r) => r.delivered)).toHaveLength(1);
    expect([a, b].filter((r) => !r.delivered)).toHaveLength(1);
    expect(runs).toBe(1);
    console.log("postgres_webhook_concurrency", { runs, delivered: 1 });
    console.log("postgres_refs_after_delete", refs);
  } finally {
    await store.close();
    await webhooks.close();
  }
});

it.runIf(Boolean(databaseUrl))("Postgres: two workers, one deletion — steps run once (row lease)", async () => {
  const store = await createPostgresWorkspaceStore(databaseUrl);
  const fly = createFakeFlyClient();
  const destroyCalls: string[] = [];
  const originalDestroy = fly.destroyApp.bind(fly);
  fly.destroyApp = async (appName) => {
    destroyCalls.push(appName);
    // Hold the lock window so the peer processQueue overlaps.
    await new Promise((r) => setTimeout(r, 80));
    return originalDestroy(appName);
  };
  try {
    const { id, appName } = await seedWorkspace(store, "lease");
    await fly.createApp({ appName, org: "fizot", network: `net-${id}` });
    await fly.createVolume({ appName, name: "omb_home", region: "lhr", sizeGb: 10 });
    await fly.createMachine({
      appName,
      region: "lhr",
      name: "home",
      image: "img",
      volumeId: (await fly.listVolumes(appName))[0]!.id,
      env: {},
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
      autoDestroy: true,
    });

    const runnerA = createDeletionRunner({ store, fly, workerId: "pg-worker-a", backoffMs: 1, maxAttempts: 8 });
    const runnerB = createDeletionRunner({ store, fly, workerId: "pg-worker-b", backoffMs: 1, maxAttempts: 8 });
    await runnerA.requestDeletion(id);

    const [ra, rb] = await Promise.all([
      runnerA.processQueue(),
      runnerB.processQueue(),
    ]);
    const statuses = [...ra, ...rb].map((r) => r.status);
    expect(statuses.some((s) => s === "complete")).toBe(true);
    expect(destroyCalls.filter((c) => c === appName).length).toBe(1);
    expect(await store.listTransitions(id)).toHaveLength(0);
    expect((await countWorkspaceRefs(store, undefined, undefined, id)).remainingCount).toBe(0);
    console.log("postgres_two_workers", {
      destroyCalls: destroyCalls.length,
      stepRunsA: runnerA.stepRuns,
      stepRunsB: runnerB.stepRuns,
      statuses,
    });
    // Combined step executions should not double every step (lease serializes).
    expect(runnerA.stepRuns + runnerB.stepRuns).toBeLessThan(DELETION_STEPS.length * 2);
  } finally {
    await store.close();
  }
});
