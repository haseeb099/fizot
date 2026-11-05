/**
 * AD-I: state machine, deletion receipt, webhook dedupe on real Postgres.
 * Runs only when ADMIN_DATABASE_URL is set (admin-postgres.yml).
 */
import { expect, it } from "vitest";
import {
  createPostgresWorkspaceStore,
  createPostgresWebhookEventStore,
  createDeletionRunner,
  createFakeFlyClient,
  deliverWebhookEvent,
  mayTransition,
} from "../../../server/fizot/admin/public.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL?.trim() ?? "";

it.runIf(Boolean(databaseUrl))("Postgres: transitions + deletion receipt + webhook unique under concurrency", async () => {
  const store = await createPostgresWorkspaceStore(databaseUrl);
  const webhooks = await createPostgresWebhookEventStore(databaseUrl);
  const fly = createFakeFlyClient();
  try {
    const id = `pg-life-${Date.now()}`;
    const createdAt = new Date().toISOString();
    await store.create({
      id,
      plan: "home",
      appName: `fizot-cm-${id.slice(-12)}`,
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
    expect(mayTransition("requested", "creating")).toBe(true);
    await store.transition(id, "creating", "start");
    await store.transition(id, "ready", "done");
    const transitions = await store.listTransitions(id);
    expect(transitions.map((t) => t.toState)).toEqual(["requested", "creating", "ready"]);

    await fly.createApp({ appName: `fizot-cm-${id.slice(-12)}`, org: "fizot", network: `net-${id}` });
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
  } finally {
    await store.close();
    await webhooks.close();
  }
});
