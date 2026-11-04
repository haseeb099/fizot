import { expect, it } from "vitest";
import {
  createAdminServices,
  createFakeFlyClient,
  createMemoryNonceStore,
  createMemoryWorkspaceStore,
} from "../../../server/fizot/admin/public.ts";

it("sleep stops the Fly machine after prepareSleep; wake starts it again", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  let idle = false;
  const services = createAdminServices({
    adminUrl: "https://admin.example.invalid",
    flyOrg: "fizot-test",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
    machineFetch: async (input, init) => {
      const url = String(input);
      if (url.includes("/api/cloud/power/sleep") && (init?.method ?? "GET") === "POST") {
        if (!idle) {
          return new Response(JSON.stringify({ ok: false, busy: ["just-woke"] }), { status: 409 });
        }
        return new Response(JSON.stringify({ ok: true, nextDueAt: null }), { status: 200 });
      }
      if (url.includes("/api/cloud/power")) {
        return new Response(JSON.stringify({
          v: 1,
          idle,
          busy: idle ? [] : ["just-woke"],
          wokeAt: Date.now() - (idle ? 180_000 : 0),
          sleeping: false,
        }), { status: 200 });
      }
      if (url.includes("/api/cloud/health")) {
        return new Response(JSON.stringify({ ok: true, v: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    },
  });

  const workspace = await services.createWorkspace({ plan: "home", ownerEmail: "a@b.co" });
  const before = await fly.getMachine(workspace.appName, workspace.flyMachineId);
  expect(before.state).toBe("started");

  // First attempt would 409; flip idle after a tick so the poll succeeds.
  setTimeout(() => { idle = true; }, 50);
  const slept = await services.workspaceSleep(workspace.id, { idleMinutes: 1, waitMs: 5_000 });
  expect(slept.body).toMatchObject({ ok: true, machineState: "suspended" });
  expect(fly.calls.some((c) => c.startsWith(`suspendMachine:${workspace.appName}:`))).toBe(true);
  expect((await fly.getMachine(workspace.appName, workspace.flyMachineId)).state).toBe("suspended");

  const woke = await services.workspaceWake(workspace.id, { healthWaitMs: 5_000 });
  expect(woke.body).toMatchObject({ ok: true, machineState: "started" });
  expect(fly.calls.some((c) => c.startsWith(`startMachine:${workspace.appName}:`))).toBe(true);
  expect((await fly.getMachine(workspace.appName, workspace.flyMachineId)).state).toBe("started");
});
