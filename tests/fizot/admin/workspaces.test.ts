import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  createAdminServices,
  createFakeFlyClient,
  createMemoryNonceStore,
  createMemoryWorkspaceStore,
  planFlags,
  assertPlanAllows,
} from "../../../server/fizot/admin/public.ts";
import { teamRoleScopes } from "../../../server/cloud-team.ts";

it("plan flags match the Fly home shape", () => {
  expect(planFlags("home")).toMatchObject({ role: "home", volumeGb: 10, memoryMb: 2048, cpus: 1, sleepAllowed: true });
  expect(planFlags("team")).toMatchObject({ role: "team", sleepAllowed: false });
  expect(planFlags("enterprise")).toBeNull();
  expect(assertPlanAllows("team", "sleepAllowed", false)).toBe(true);
  expect(assertPlanAllows("home", "sleepAllowed", false)).toBe(false);
  expect(teamRoleScopes("owner")).toEqual(["admin", "client"]);
  expect(teamRoleScopes("member")).toEqual(["client"]);
});

it("creates a Fly app, volume, secrets and machine through the fake client", async () => {
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
  const workspace = await services.createWorkspace({ plan: "home", ownerEmail: "owner@example.com" });
  expect(workspace.appName).toMatch(/^fizot-cm-/);
  expect(workspace.network).toMatch(/^fizot-net-/);
  expect(workspace.publicUrl).toBe(`https://${workspace.appName}.fly.dev`);
  expect(fly.calls).toEqual([
    `createApp:${workspace.appName}`,
    `allocateIps:${workspace.appName}`,
    `createVolume:${workspace.appName}:omb_home`,
    `setSecrets:${workspace.appName}`,
    `createMachine:${workspace.appName}:home`,
  ]);
  expect(fly.ips.get(workspace.appName)?.via).toBe("fake");
  expect(fly.secrets.get(workspace.appName)).toEqual({
    OMB_CLOUD_ADMIN_URL: "https://admin.example.invalid",
    OMB_CLOUD_BOOTSTRAP_SECRET: workspace.bootstrapSecret,
  });
  expect(fly.volumes.get(`${workspace.appName}/omb_home`)?.sizeGb).toBe(10);
  expect(await store.get(workspace.id)).toMatchObject({ ownerEmail: "owner@example.com", role: "home" });
});

it("signs health, power and pairing against a fake machine", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  const seen: string[] = [];
  const machine = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const signature = req.headers["x-omb-cloud-signature"];
    expect(signature).toMatch(/^v1=/);
    if (req.url?.startsWith("/api/cloud/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, ok: true }));
      return;
    }
    if (req.url === "/api/cloud/power") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, state: "running" }));
      return;
    }
    if (req.url === "/api/cloud/pairing") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "ABCD-EFGH-JKLM", credential: "omb_pair_test", expiresAt: 1 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => machine.listen(0, "127.0.0.1", () => resolve()));
  const address = machine.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const publicUrl = `http://127.0.0.1:${address.port}`;

  const services = createAdminServices({
    adminUrl: "https://admin.example.invalid",
    flyOrg: "fizot-test",
    flyRegion: "lhr",
    machineImage: "img",
    fly,
    store,
    nonces: createMemoryNonceStore(),
    machineFetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(url.replace(/^https:\/\/[^/]+/, publicUrl), init);
    },
  });
  const workspace = await services.createWorkspace({ plan: "home", ownerEmail: "a@b.co" });
  // Point the stored public URL at the fake listener via fetch rewrite above.
  const health = await services.workspaceHealth(workspace.id);
  expect(health.status).toBe(200);
  expect(health.body).toMatchObject({ v: 1, ok: true });
  const power = await services.workspacePower(workspace.id);
  expect(power.body).toMatchObject({ state: "running" });
  const pairing = await services.workspacePairing(workspace.id, { label: "test" });
  expect(pairing.body.pairingLink).toContain("/pair#signin=");
  expect(seen).toEqual([
    "GET /api/cloud/health?after=0",
    "GET /api/cloud/power",
    "POST /api/cloud/pairing",
  ]);
  await new Promise<void>((resolve, reject) => machine.close((error) => error ? reject(error) : resolve()));
});

it("applies team member claim scopes on pairing", async () => {
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
    machineFetch: async () => new Response(JSON.stringify({ credential: "omb_pair_team" }), { status: 200 }),
  });
  const workspace = await services.createWorkspace({
    plan: "team",
    teamId: "team-1",
    teamName: "Acme",
  });
  const owner = await services.workspacePairing(workspace.id, {
    member: { email: "owner@acme.test", role: "owner" },
  });
  expect(owner.body.scopes).toEqual(["admin", "client"]);
  const member = await services.workspacePairing(workspace.id, {
    member: { email: "user@acme.test", role: "member" },
  });
  expect(member.body.scopes).toEqual(["client"]);
});
