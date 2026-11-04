/**
 * AD-I / TC27 on real Postgres: membership JOIN isolation + two-tenant HTTP surface.
 * Runs only when ADMIN_DATABASE_URL is set (admin-postgres.yml).
 */
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createAdminServer } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";
import {
  createFakeFlyClient,
  createMemoryNonceStore,
  createPostgresWorkspaceStore,
} from "../../../server/fizot/admin/public.ts";
import { createPostgresTenantStore } from "../../../server/fizot/admin/tenant.ts";

const databaseUrl = process.env.ADMIN_DATABASE_URL;

function cookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const hit = raw.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!hit) throw new Error("missing session cookie");
  return hit.split(";")[0]!;
}

it.skipIf(!databaseUrl)("Postgres JOIN: workspace rows require membership (AD-I)", async () => {
  const store = await createPostgresWorkspaceStore(databaseUrl!);
  const tenant = await createPostgresTenantStore(databaseUrl!, store);
  const suffix = Date.now();
  const home = await store.create({
    id: `ws-home-${suffix}`,
    plan: "home",
    appName: `fizot-home-${suffix}`,
    network: `net-home-${suffix}`,
    machineId: `cm-home-${suffix}`,
    flyMachineId: `mach-home-${suffix}`,
    flyVolumeId: `vol-home-${suffix}`,
    publicUrl: `https://home-${suffix}.example.invalid`,
    role: "home",
    bootstrapSecret: "b".repeat(43),
    createdAt: new Date().toISOString(),
    ownerEmail: "alice@example.com",
  });
  const team = await store.create({
    id: `ws-team-${suffix}`,
    plan: "team",
    appName: `fizot-team-${suffix}`,
    network: `net-team-${suffix}`,
    machineId: `cm-team-${suffix}`,
    flyMachineId: `mach-team-${suffix}`,
    flyVolumeId: `vol-team-${suffix}`,
    publicUrl: `https://team-${suffix}.example.invalid`,
    role: "team",
    bootstrapSecret: "c".repeat(43),
    createdAt: new Date().toISOString(),
    teamId: `team-acme-${suffix}`,
    teamName: "Acme",
  });

  const alice = await tenant.ensureAccount("alice@example.com");
  const bob = await tenant.ensureAccount("bob@example.com");
  await tenant.upsertMembership(alice.id, home.id, "owner");
  await tenant.upsertMembership(bob.id, team.id, "owner");

  expect(await tenant.getWorkspaceForMember(alice.id, home.id)).toMatchObject({ workspace: { id: home.id } });
  expect(await tenant.getWorkspaceForMember(alice.id, team.id)).toBeNull();
  expect(await tenant.getWorkspaceForMember(bob.id, home.id)).toBeNull();
  expect((await tenant.listWorkspacesForAccount(alice.id)).map((r) => r.workspace.id)).toEqual([home.id]);
  expect((await tenant.listWorkspacesForAccount(bob.id)).map((r) => r.workspace.id)).toEqual([team.id]);

  // Legacy owner/tenant list helpers still exist on the store; membership gate is authoritative for HTTP.
  expect(await store.listByOwner("alice@example.com")).toEqual([expect.objectContaining({ id: home.id })]);
  expect(await store.listByTenant(`team-acme-${suffix}`)).toEqual([expect.objectContaining({ id: team.id })]);

  await tenant.close();
  await store.close();
});

it.skipIf(!databaseUrl)("TC27 on Postgres: A cannot read/list/pair/power/delete B", async () => {
  const fly = createFakeFlyClient();
  const store = await createPostgresWorkspaceStore(databaseUrl!);
  const tenant = await createPostgresTenantStore(databaseUrl!, store);
  const machine = createServer((req, res) => {
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
      res.end(JSON.stringify({ code: "P", credential: "omb_pair", expiresAt: 1 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => machine.listen(0, "127.0.0.1", () => resolve()));
  const address = machine.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const machineOrigin = `http://127.0.0.1:${address.port}`;

  const admin = await createAdminServer({
    fly,
    store,
    tenant,
    cookieSecure: false,
    nonces: createMemoryNonceStore(),
    machineFetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(url.replace(/^https:\/\/[^/]+/, machineOrigin), init);
    },
  });

  try {
    async function signIn(email: string) {
      const res = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      expect(res.status).toBe(200);
      return cookieFrom(res);
    }
    async function createWs(cookie: string, email: string) {
      const res = await fetch(`${admin.url}/admin/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ plan: "home", ownerEmail: email }),
      });
      expect(res.status).toBe(201);
      return (await res.json() as { workspace: { id: string } }).workspace;
    }

    const stamp = Date.now();
    const cookieA = await signIn(`alice-pg-${stamp}@tc27.test`);
    const cookieB = await signIn(`bob-pg-${stamp}@tc27.test`);
    const meA = await (await fetch(`${admin.url}/edge/me`, { headers: { cookie: cookieA } })).json() as {
      account: { email: string };
    };
    const meB = await (await fetch(`${admin.url}/edge/me`, { headers: { cookie: cookieB } })).json() as {
      account: { email: string };
    };
    const wsA = await createWs(cookieA, meA.account.email);
    const wsB = await createWs(cookieB, meB.account.email);

    const listA = await (await fetch(`${admin.url}/admin/workspaces`, { headers: { cookie: cookieA } })).json() as {
      workspaces: Array<{ id: string }>;
    };
    expect(listA.workspaces.map((w) => w.id)).toContain(wsA.id);
    expect(listA.workspaces.map((w) => w.id)).not.toContain(wsB.id);

    for (const path of [
      `/admin/workspaces/${wsB.id}/power`,
      `/admin/workspaces/${wsB.id}/health`,
    ]) {
      const res = await fetch(`${admin.url}${path}`, { headers: { cookie: cookieA } });
      expect(res.status).toBe(404);
    }
    for (const [method, path] of [
      ["POST", `/admin/workspaces/${wsB.id}/pairing`],
      ["DELETE", `/admin/workspaces/${wsB.id}`],
      ["POST", `/edge/workspaces/${wsB.id}/open`],
    ] as const) {
      const res = await fetch(`${admin.url}${path}`, {
        method,
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: method === "DELETE" ? undefined : "{}",
      });
      expect(res.status).toBe(404);
    }

    expect((await fetch(`${admin.url}/admin/workspaces/${wsB.id}/power`, { headers: { cookie: cookieB } })).status).toBe(200);
  } finally {
    await admin.close();
    await new Promise<void>((resolve, reject) => machine.close((e) => (e ? reject(e) : resolve())));
  }
});
