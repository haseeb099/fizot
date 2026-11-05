/**
 * TC27: two live instances (two workspaces, two accounts) — account A cannot
 * read, list, pair with, power, or delete workspace B by id, guessing,
 * replaying B's signed machine request, or swapping Host/path.
 * Daily gate uses fakes; Postgres variant is admin-postgres.yml.
 */
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  adminRequestSignature,
  createFakeFlyClient,
  createMemoryNonceStore,
  createMemoryWorkspaceStore,
  mintNonce,
} from "../../../server/fizot/admin/public.ts";
import { createAdminServer } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";
import { createMemoryTenantStore } from "../../../server/fizot/admin/tenant.ts";

function cookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const hit = raw.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!hit) throw new Error("missing session cookie");
  return hit.split(";")[0]!;
}

async function signIn(url: string, email: string): Promise<string> {
  const res = await fetch(`${url}/edge/auth/fake-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

async function createOwnedWorkspace(url: string, cookie: string, ownerEmail: string) {
  const res = await fetch(`${url}/admin/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ plan: "home", ownerEmail }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { workspace: { id: string; bootstrapSecret?: string; publicUrl: string } };
  return body.workspace;
}

it("TC27: account A cannot touch workspace B (fake Fly / memory store)", async () => {
  const fly = createFakeFlyClient();
  const store = createMemoryWorkspaceStore();
  const tenant = createMemoryTenantStore(store);
  const machine = createServer((req, res) => {
    const signature = req.headers["x-omb-cloud-signature"];
    if (typeof signature !== "string" || !signature.startsWith("v1=")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_signature" }));
      return;
    }
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
      res.end(JSON.stringify({ code: "PAIR-CODE", credential: "omb_pair_tc27", expiresAt: 1 }));
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
    const cookieA = await signIn(admin.url, "alice@tc27.test");
    const cookieB = await signIn(admin.url, "bob@tc27.test");
    const wsA = await createOwnedWorkspace(admin.url, cookieA, "alice@tc27.test");
    const wsB = await createOwnedWorkspace(admin.url, cookieB, "bob@tc27.test");
    const storedB = await store.get(wsB.id);
    expect(storedB).toBeTruthy();

    // A can use own workspace.
    expect((await fetch(`${admin.url}/admin/workspaces/${wsA.id}/power`, { headers: { cookie: cookieA } })).status).toBe(200);

    const listA = await (await fetch(`${admin.url}/admin/workspaces`, { headers: { cookie: cookieA } })).json() as {
      workspaces: Array<{ id: string }>;
    };
    expect(listA.workspaces.map((w) => w.id)).toEqual([wsA.id]);

    // By id: read / power / pairing / delete / edge open → same 404.
    for (const [method, path] of [
      ["GET", `/admin/workspaces/${wsB.id}/power`],
      ["GET", `/admin/workspaces/${wsB.id}/health`],
      ["POST", `/admin/workspaces/${wsB.id}/pairing`],
      ["DELETE", `/admin/workspaces/${wsB.id}`],
      ["POST", `/edge/workspaces/${wsB.id}/open`],
    ] as const) {
      const res = await fetch(`${admin.url}${path}`, {
        method,
        headers: {
          cookie: cookieA,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify({ label: "probe" }) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }

    // Guessing: random / near ids.
    for (const guess of [`${wsB.id}-x`, "00000000-0000-0000-0000-000000000000", wsB.id.toUpperCase()]) {
      const res = await fetch(`${admin.url}/admin/workspaces/${encodeURIComponent(guess)}/power`, {
        headers: { cookie: cookieA },
      });
      expect(res.status).toBe(404);
    }

    // Replay B's signed machine request as Admin headers — must not authorize A on B.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = mintNonce();
    const target = "/api/cloud/power";
    const sig = adminRequestSignature(storedB!.bootstrapSecret, timestamp, nonce, "GET", target, "");
    const replay = await fetch(`${admin.url}/admin/workspaces/${wsB.id}/power`, {
      headers: {
        cookie: cookieA,
        "x-omb-cloud-timestamp": timestamp,
        "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${sig}`,
        host: new URL(storedB!.publicUrl).host,
      },
    });
    expect(replay.status).toBe(404);

    // Path / Host swap: A's session, B's id in path, Host claiming A's public URL.
    const swap = await fetch(`${admin.url}/admin/workspaces/${wsB.id}/power`, {
      headers: {
        cookie: cookieA,
        host: new URL(wsA.publicUrl).host,
      },
    });
    expect(swap.status).toBe(404);

    // me / edge list never includes B for A.
    const me = await (await fetch(`${admin.url}/edge/me`, { headers: { cookie: cookieA } })).json() as {
      workspaces: Array<{ id: string }>;
    };
    expect(me.workspaces.map((w) => w.id)).toEqual([wsA.id]);

    // B still intact.
    expect(await store.get(wsB.id)).toBeTruthy();
    expect((await fetch(`${admin.url}/admin/workspaces/${wsB.id}/power`, { headers: { cookie: cookieB } })).status).toBe(200);
  } finally {
    await admin.close();
    await new Promise<void>((resolve, reject) => machine.close((e) => (e ? reject(e) : resolve())));
  }
});
