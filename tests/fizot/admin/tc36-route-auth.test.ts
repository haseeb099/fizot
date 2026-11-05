/**
 * TC36: object-level auth sweep via ONE dispatch table.
 * Cases: none / stranger / member / admin / owner.
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

/** Expected HTTP status for each auth level × cookie persona. */
function expectedFor(route: { auth: string; minRole?: string; id: string }, persona: string): number {
  // Public webhook verifies its own signature — unsigned probes must never reach the handler success path.
  if (route.id === "admin.webhook" || route.id === "admin.creditGrant" || route.id === "admin.proxyKill") return 401;
  if (route.auth === "public") return 200;
  if (persona === "none") return 401;
  if (route.auth === "session") return 200;
  if (persona === "stranger") return 404;
  if (route.minRole === "owner") return persona === "owner" ? 200 : 404;
  if (route.minRole === "admin") return persona === "member" ? 404 : 200;
  return 200;
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
  for (const route of ROUTE_REGISTRY) {
    const entry = ADMIN_DISPATCH_TABLE.find((e) => e.id === route.id)!;
    expect(entry.auth).toBe(route.auth);
    expect(typeof entry.handler).toBe("function");
  }
});

it("TC36: every registry route — none / stranger / member / admin / owner", async () => {
  const fly = createFakeFlyClient();
  let idle = true;
  const machine = createServer((req, res) => {
    if (req.url?.includes("/member-left")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url?.includes("/power/sleep") && (req.method ?? "GET") === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url?.includes("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, ok: true }));
      return;
    }
    if (req.url?.includes("/power")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, idle, busy: idle ? [] : ["just-woke"], wokeAt: Date.now() - 180_000, state: "running" }));
      return;
    }
    if (req.url?.includes("/pairing")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "PAIR", credential: "omb_pair_tc36" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => machine.listen(0, "127.0.0.1", () => resolve()));
  const address = machine.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const machineOrigin = `http://127.0.0.1:${address.port}`;

  const adminSrv = await createAdminServer({
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
    let ownerCookie = await signIn(adminSrv.url, "owner-tc36@example.com");
    let adminCookie = await signIn(adminSrv.url, "admin-tc36@example.com");
    let memberCookie = await signIn(adminSrv.url, "member-tc36@example.com");
    let strangerCookie = await signIn(adminSrv.url, "stranger-tc36@example.com");

    const created = await fetch(`${adminSrv.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        plan: "team",
        ownerEmail: "owner-tc36@example.com",
        teamId: "team-tc36",
        teamName: "TC36",
      }),
    });
    expect(created.status).toBe(201);
    const wsId = (await created.json() as { workspace: { id: string } }).workspace.id;

    async function acceptRole(email: string, role: "admin" | "member", actor: string) {
      const inv = await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: actor },
        body: JSON.stringify({ email, role }),
      });
      expect(inv.status).toBe(201);
      const token = (await inv.json() as { token: string }).token;
      const cookie = email === "admin-tc36@example.com" ? adminCookie
        : email === "member-tc36@example.com" ? memberCookie
          : await signIn(adminSrv.url, email);
      expect((await fetch(`${adminSrv.url}/edge/invites/${token}/accept`, {
        method: "POST",
        headers: { cookie },
      })).status).toBe(200);
    }
    await acceptRole("admin-tc36@example.com", "admin", ownerCookie);
    await acceptRole("member-tc36@example.com", "member", adminCookie);

    const membersList = await (await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/members`, {
      headers: { cookie: ownerCookie },
    })).json() as { members: Array<{ accountId: string; email: string }> };
    const memberAccountId = membersList.members.find((m) => m.email === "member-tc36@example.com")!.accountId;

    // Standing members = 3; seatMax = 5 → room for 2 invite/remove operations at a time.
    // Mint accept-token just-in-time (do not leave pending invites that fill seats).
    let pendingToken = "deadbeef";
    let revokeInviteId = "missing";
    let destroyWsId: string | null = null;

    const personas: Array<{ name: string; cookie: string | null }> = [
      { name: "none", cookie: null },
      { name: "stranger", cookie: strangerCookie },
      { name: "member", cookie: memberCookie },
      { name: "admin", cookie: adminCookie },
      { name: "owner", cookie: ownerCookie },
    ];

    for (const route of ROUTE_REGISTRY) {
      if (route.id === "admin.destroyWorkspace" && !destroyWsId) {
        const d = await fetch(`${adminSrv.url}/admin/workspaces`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            plan: "team",
            ownerEmail: "owner-tc36@example.com",
            teamId: `team-d-${Date.now()}`,
            teamName: "Destroy",
          }),
        });
        destroyWsId = (await d.json() as { workspace: { id: string } }).workspace.id;
      }

      if (route.id === "edge.acceptInvite") {
        const inv = await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({ email: "pending-tc36@example.com", role: "member" }),
        });
        expect(inv.status).toBe(201);
        pendingToken = (await inv.json() as { token: string }).token;
      }

      for (const persona of personas) {
        let want = expectedFor(route, persona.name);
        let accountIdForPath = memberAccountId;
        let inviteIdForPath = revokeInviteId;

        if (route.id === "admin.sleep") {
          if (persona.name === "none") want = 401;
          else if (persona.name === "stranger" || persona.name === "member") want = 404;
          else want = 409;
        }
        if (route.id === "admin.createWorkspace" && persona.cookie) want = 201;
        if (route.id === "edge.fakeSignIn") want = 200;
        if (route.id === "edge.signOut" && persona.cookie) want = 200;
        if (route.id === "edge.acceptInvite") {
          if (persona.name === "none") want = 401;
          else want = 404; // wrong email for pending-tc36@…
        }
        if (route.id === "admin.createInvite" && (persona.name === "admin" || persona.name === "owner")) {
          want = 201;
        }
        if (route.id === "admin.revokeInvite" && (persona.name === "admin" || persona.name === "owner")) {
          const inv = await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: ownerCookie },
            body: JSON.stringify({ email: `revoke-${persona.name}-${Date.now()}@example.com`, role: "member" }),
          });
          expect(inv.status).toBe(201);
          inviteIdForPath = (await inv.json() as { invite: { id: string } }).invite.id;
          revokeInviteId = inviteIdForPath;
          want = 200;
        }
        if (route.id === "admin.patchMember" && (persona.name === "admin" || persona.name === "owner")) {
          want = 200;
        }
        if (route.id === "admin.removeMember") {
          if (persona.name === "none") want = 401;
          else if (persona.name === "stranger" || persona.name === "member") want = 404;
          else {
            const disposableEmail = `rm-${persona.name}-${Date.now()}@example.com`;
            const inv = await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites`, {
              method: "POST",
              headers: { "content-type": "application/json", cookie: ownerCookie },
              body: JSON.stringify({ email: disposableEmail, role: "member" }),
            });
            expect(inv.status).toBe(201);
            const token = (await inv.json() as { token: string }).token;
            const cookie = await signIn(adminSrv.url, disposableEmail);
            expect((await fetch(`${adminSrv.url}/edge/invites/${token}/accept`, {
              method: "POST",
              headers: { cookie },
            })).status).toBe(200);
            const list = await (await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/members`, {
              headers: { cookie: ownerCookie },
            })).json() as { members: Array<{ accountId: string; email: string }> };
            accountIdForPath = list.members.find((m) => m.email === disposableEmail)!.accountId;
            want = 200;
          }
        }
        if (route.id === "admin.destroyWorkspace" && persona.name === "owner") want = 202;
        if (route.id === "admin.eraseAccount" && persona.cookie) want = 400; // confirm_required
        if (route.id === "admin.deletionReceipt" && persona.cookie) want = 404; // no receipt yet on live ws
        if (route.id === "admin.webhook") want = 401; // unsigned / badly signed

        let body: string | undefined;
        if (route.method !== "GET" && route.method !== "DELETE") {
          if (route.id === "edge.fakeSignIn") body = JSON.stringify({ email: `tc36-${persona.name}@example.com` });
          else if (route.id === "admin.createWorkspace") {
            body = JSON.stringify({
              plan: "home",
              ownerEmail:
                persona.name === "owner" ? "owner-tc36@example.com"
                  : persona.name === "admin" ? "admin-tc36@example.com"
                    : persona.name === "member" ? "member-tc36@example.com"
                      : persona.name === "stranger" ? "stranger-tc36@example.com"
                        : "anon@example.com",
            });
          } else if (route.id === "admin.createInvite") {
            body = JSON.stringify({ email: `inv-${persona.name}-${Date.now()}@example.com`, role: "member" });
          } else if (route.id === "admin.patchMember") {
            body = JSON.stringify({ role: "member" });
          } else if (route.id === "admin.pairing") {
            body = JSON.stringify({ label: "tc36", member: { email: "member-tc36@example.com", role: "owner" } });
          } else if (route.id === "admin.sleep") {
            body = JSON.stringify({ idleMinutes: 1, waitMs: 1000 });
          } else if (route.id === "admin.wake") {
            body = JSON.stringify({ healthWaitMs: 1000 });
          } else if (route.id === "admin.webhook") {
            body = JSON.stringify({ id: "evt_unsigned", type: "test" });
          } else {
            body = "{}";
          }
        }
        if (route.id === "admin.eraseAccount" && persona.cookie) {
          body = JSON.stringify({}); // missing confirm → 400
        }

        const pathNow = route.path
          .replace(":workspaceId", route.id === "admin.destroyWorkspace" ? destroyWsId! : wsId)
          .replace(":accountId", accountIdForPath)
          .replace(":inviteId", inviteIdForPath)
          .replace(":token", pendingToken)
          .replace(":provider", "generic");

        const res = await fetch(`${adminSrv.url}${pathNow}`, {
          method: route.method,
          headers: {
            ...(route.method === "GET" ? {} : { "content-type": "application/json" }),
            ...(persona.cookie ? { cookie: persona.cookie } : {}),
          },
          body,
        });
        expect(res.status, `${route.id} ${persona.name}`).toBe(want);
        sweep.push(`${route.method} ${route.path} auth=${route.auth} ${persona.name}=${res.status}`);

        if (route.id === "admin.createWorkspace" && res.status === 201) {
          const bodyJson = await res.json() as { workspace?: { id: string } };
          if (bodyJson.workspace?.id) await adminSrv.services.destroyWorkspace(bodyJson.workspace.id);
        }
        if (route.id === "admin.createInvite" && res.status === 201) {
          // Revoke immediately so seats stay free for later remove/invite steps.
          const createdInv = await res.json() as { invite: { id: string } };
          await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites/${createdInv.invite.id}`, {
            method: "DELETE",
            headers: { cookie: ownerCookie },
          });
        }
        if (route.id === "admin.destroyWorkspace" && persona.name === "owner" && res.status === 202) {
          destroyWsId = null;
        }
      }

      // Drop the acceptInvite pending invite after the five persona hits (all 404).
      if (route.id === "edge.acceptInvite") {
        const listed = await (await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites`, {
          headers: { cookie: ownerCookie },
        })).json() as { invites: Array<{ id: string; email: string }> };
        for (const inv of listed.invites.filter((i) => i.email === "pending-tc36@example.com")) {
          await fetch(`${adminSrv.url}/admin/workspaces/${wsId}/invites/${inv.id}`, {
            method: "DELETE",
            headers: { cookie: ownerCookie },
          });
        }
      }

      if (route.id === "edge.fakeSignIn" || route.id === "edge.signOut") {
        ownerCookie = await signIn(adminSrv.url, "owner-tc36@example.com");
        adminCookie = await signIn(adminSrv.url, "admin-tc36@example.com");
        memberCookie = await signIn(adminSrv.url, "member-tc36@example.com");
        strangerCookie = await signIn(adminSrv.url, "stranger-tc36@example.com");
        personas[1]!.cookie = strangerCookie;
        personas[2]!.cookie = memberCookie;
        personas[3]!.cookie = adminCookie;
        personas[4]!.cookie = ownerCookie;
      }
    }

    console.log(`TC36 swept ${ROUTE_REGISTRY.length} routes × 5 cookie cases:\n${sweep.join("\n")}`);
  } finally {
    await adminSrv.close();
    await new Promise<void>((resolve, reject) => machine.close((e) => (e ? reject(e) : resolve())));
  }
});
