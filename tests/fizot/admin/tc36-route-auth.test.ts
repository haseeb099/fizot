/**
 * TC36: object-level auth sweep. The HTTP dispatcher serves only ROUTE_REGISTRY
 * entries (each with auth + handler). No source grepping — exercise every route
 * with no cookie, another account's cookie, and a member cookie.
 */
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  ADMIN_DISPATCH_TABLE,
  assertRouteHasAuth,
  buildDispatchTable,
  createFakeFlyClient,
  createMemoryNonceStore,
  ROUTE_REGISTRY,
} from "../../../server/fizot/admin/public.ts";
import { createAdminServer, FakeAuthProvider } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";

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

function expectedStatuses(auth: "public" | "session" | "membership"): {
  none: number;
  stranger: number;
  member: number;
} {
  if (auth === "public") return { none: 200, stranger: 200, member: 200 };
  if (auth === "session") return { none: 401, stranger: 200, member: 200 };
  return { none: 401, stranger: 404, member: 200 };
}

it("TC36 negative: a route without an auth level fails registration", () => {
  expect(() => assertRouteHasAuth({ id: "evil.open", auth: undefined })).toThrow(/missing auth level/);
  expect(() =>
    buildDispatchTable(
      [{ id: "evil.open", method: "GET", path: "/evil", surface: "admin" } as never],
      { "evil.open": async () => {} },
    ),
  ).toThrow(/missing auth level/);
});

it("TC36: dispatcher table covers exactly ROUTE_REGISTRY with handlers", () => {
  expect(ADMIN_DISPATCH_TABLE).toHaveLength(ROUTE_REGISTRY.length);
  const ids = new Set(ADMIN_DISPATCH_TABLE.map((e) => e.id));
  for (const route of ROUTE_REGISTRY) {
    expect(ids.has(route.id)).toBe(true);
    const entry = ADMIN_DISPATCH_TABLE.find((e) => e.id === route.id)!;
    expect(entry.auth).toBe(route.auth);
    expect(typeof entry.handler).toBe("function");
  }
});

it("TC36: every registry route — no cookie / stranger / member", async () => {
  const fly = createFakeFlyClient();
  let idle = true;
  const machine = createServer((req, res) => {
    if (req.url?.includes("/api/cloud/power/sleep") && (req.method ?? "GET") === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, nextDueAt: null }));
      return;
    }
    if (req.url?.includes("/api/cloud/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, ok: true }));
      return;
    }
    if (req.url?.includes("/api/cloud/power")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        v: 1,
        idle,
        busy: idle ? [] : ["just-woke"],
        wokeAt: Date.now() - 180_000,
        sleeping: false,
        state: "running",
      }));
      return;
    }
    if (req.url?.includes("/api/cloud/pairing")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "PAIR", credential: "omb_pair_tc36", expiresAt: 1 }));
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
    auth: new FakeAuthProvider(),
    cookieSecure: false,
    nonces: createMemoryNonceStore(),
    machineFetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(url.replace(/^https:\/\/[^/]+/, machineOrigin), init);
    },
  });

  const sweep: string[] = [];
  try {
    let memberCookie = await signIn(admin.url, "member-tc36@example.com");
    let strangerCookie = await signIn(admin.url, "stranger-tc36@example.com");

    const created = await fetch(`${admin.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ plan: "home", ownerEmail: "member-tc36@example.com" }),
    });
    expect(created.status).toBe(201);
    const memberWs = (await created.json() as { workspace: { id: string } }).workspace;
    let destroyWsId: string | null = null;

    for (const route of ROUTE_REGISTRY) {
      const expectFor = expectedStatuses(route.auth);
      if (route.id === "admin.destroyWorkspace" && !destroyWsId) {
        const destroyCreated = await fetch(`${admin.url}/admin/workspaces`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: memberCookie },
          body: JSON.stringify({ plan: "home", ownerEmail: "member-tc36@example.com" }),
        });
        expect(destroyCreated.status).toBe(201);
        destroyWsId = (await destroyCreated.json() as { workspace: { id: string } }).workspace.id;
      }
      const workspaceId = route.id === "admin.destroyWorkspace" ? destroyWsId! : memberWs.id;
      const pathFilled = route.path.replace(":workspaceId", workspaceId);

      const bodyFor = (cookie: string | null) => {
        if (route.method === "GET" || route.method === "DELETE") return undefined;
        if (route.id === "edge.fakeSignIn") {
          return JSON.stringify({ email: cookie ? "tc36-public@example.com" : "tc36-anon@example.com" });
        }
        if (route.id === "admin.createWorkspace") {
          return JSON.stringify({
            plan: "home",
            ownerEmail: cookie === memberCookie
              ? "member-tc36@example.com"
              : cookie === strangerCookie
                ? "stranger-tc36@example.com"
                : "anon@example.com",
          });
        }
        if (route.id === "admin.sleep") return JSON.stringify({ idleMinutes: 1, waitMs: 2_000 });
        if (route.id === "admin.wake") return JSON.stringify({ healthWaitMs: 2_000 });
        if (route.id === "admin.pairing" || route.id === "edge.openWorkspace") {
          return JSON.stringify({ label: "tc36" });
        }
        return "{}";
      };

      const hit = async (label: string, cookie: string | null, expected: number) => {
        // Wake needs a stopped/suspended machine; sleep leaves it suspended — flip idle before sleep.
        if (route.id === "admin.sleep") idle = true;
        if (route.id === "admin.wake" && label === "member") {
          // Ensure machine is suspendable first via a prior sleep on the shared ws is fragile;
          // call sleep via services once so wake has something to start.
          await admin.services.workspaceSleep(memberWs.id, { idleMinutes: 1, waitMs: 2_000 });
        }
        const res = await fetch(`${admin.url}${pathFilled}`, {
          method: route.method,
          headers: {
            ...(route.method === "GET" ? {} : { "content-type": "application/json" }),
            ...(cookie ? { cookie } : {}),
          },
          body: bodyFor(cookie),
        });
        // Public fake-sign-in always 200 when FakeAuth is on; createWorkspace needs a session so
        // stranger/member get 2xx; anonymised create never runs (401 first).
        let want = expected;
        if (route.id === "admin.createWorkspace" && cookie) want = 201;
        if (route.id === "edge.fakeSignIn") want = 200;
        if (route.id === "edge.signOut" && cookie) want = 200;
        // After destroy, member status is 200; stranger/none already asserted.
        if (route.id === "admin.destroyWorkspace" && label === "member") want = 200;
        expect(res.status, `${route.id} ${label}`).toBe(want);
        sweep.push(`${route.method} ${route.path} auth=${route.auth} ${label}=${res.status}`);
        if (route.id === "admin.createWorkspace" && cookie && res.status === 201) {
          const body = await res.clone().json() as { workspace?: { id: string } };
          if (body.workspace?.id) await admin.services.destroyWorkspace(body.workspace.id);
        }
        return res;
      };

      await hit("none", null, expectFor.none);
      await hit("stranger", strangerCookie, expectFor.stranger);
      await hit("member", memberCookie, expectFor.member);

      // fake-sign-in / sign-out rotate or revoke cookies — mint fresh ones for later routes.
      if (route.id === "edge.fakeSignIn" || route.id === "edge.signOut") {
        memberCookie = await signIn(admin.url, "member-tc36@example.com");
        strangerCookie = await signIn(admin.url, "stranger-tc36@example.com");
      }
    }

    console.log(`TC36 swept ${ROUTE_REGISTRY.length} routes × 3 cookie cases:\n${sweep.join("\n")}`);
  } finally {
    await admin.close();
    await new Promise<void>((resolve, reject) => machine.close((e) => (e ? reject(e) : resolve())));
  }
});
