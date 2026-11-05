import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  createFakeFlyClient,
  createMemoryNonceStore,
} from "../../../server/fizot/admin/public.ts";
import { createAdminServer, FakeAuthProvider } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";

function cookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const hit = raw.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!hit) throw new Error("missing cookie");
  return hit.split(";")[0]!;
}

async function signIn(url: string, email: string) {
  const res = await fetch(`${url}/edge/auth/fake-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

async function bootTeam() {
  const memberLeftEmails: string[] = [];
  const machine = createServer((req, res) => {
    if (req.url?.includes("/api/cloud/team/member-left")) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        memberLeftEmails.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).email);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, chats: 1, sessions: 1 }));
      });
      return;
    }
    if (req.url?.includes("/api/cloud/pairing")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ credential: "omb_pair_x", code: "ABCD" }));
      return;
    }
    if (req.url?.includes("/api/cloud/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, v: 1 }));
      return;
    }
    if (req.url?.includes("/api/cloud/power")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, idle: false, busy: ["team"] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => machine.listen(0, "127.0.0.1", () => r()));
  const addr = machine.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${addr.port}`;
  const admin = await createAdminServer({
    fly: createFakeFlyClient(),
    auth: new FakeAuthProvider(),
    cookieSecure: false,
    nonces: createMemoryNonceStore(),
    machineFetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(url.replace(/^https:\/\/[^/]+/, origin), init);
    },
  });
  const ownerCookie = await signIn(admin.url, "owner@acme.test");
  const created = await fetch(`${admin.url}/admin/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ plan: "team", ownerEmail: "owner@acme.test", teamId: "team-1", teamName: "Acme" }),
  });
  expect(created.status).toBe(201);
  const workspaceId = (await created.json() as { workspace: { id: string } }).workspace.id;

  async function inviteAccept(actorCookie: string, email: string, role: "admin" | "member") {
    const inv = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: actorCookie },
      body: JSON.stringify({ email, role }),
    });
    expect(inv.status).toBe(201);
    const token = (await inv.json() as { token: string }).token;
    const cookie = await signIn(admin.url, email);
    expect((await fetch(`${admin.url}/edge/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie },
    })).status).toBe(200);
    return cookie;
  }

  const adminCookie = await inviteAccept(ownerCookie, "admin@acme.test", "admin");
  const memberCookie = await inviteAccept(adminCookie, "member@acme.test", "member");

  return {
    admin,
    url: admin.url,
    ownerCookie,
    adminCookie,
    memberCookie,
    workspaceId,
    memberLeftEmails,
    async close() {
      await admin.close();
      await new Promise<void>((resolve, reject) => machine.close((e) => (e ? reject(e) : resolve())));
    },
  };
}

it("invite wrong email is same 404 as unknown token; admin cannot invite admins", async () => {
  const ctx = await bootTeam();
  try {
    expect((await fetch(`${ctx.url}/admin/workspaces/${ctx.workspaceId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.adminCookie },
      body: JSON.stringify({ email: "x@acme.test", role: "admin" }),
    })).status).toBe(404);

    const inv = await fetch(`${ctx.url}/admin/workspaces/${ctx.workspaceId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.ownerCookie },
      body: JSON.stringify({ email: "other@acme.test", role: "member" }),
    });
    const token = (await inv.json() as { token: string }).token;
    const wrong = await signIn(ctx.url, "wrong@acme.test");
    expect((await fetch(`${ctx.url}/edge/invites/${token}/accept`, { method: "POST", headers: { cookie: wrong } })).status).toBe(404);
    expect((await fetch(`${ctx.url}/edge/invites/not-a-real-token/accept`, { method: "POST", headers: { cookie: wrong } })).status).toBe(404);
  } finally {
    await ctx.close();
  }
});

it("seat limit returns 409; member open pairing never elevates to admin scopes", async () => {
  const ctx = await bootTeam();
  try {
    for (const email of ["s4@acme.test", "s5@acme.test"]) {
      expect((await fetch(`${ctx.url}/admin/workspaces/${ctx.workspaceId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ctx.ownerCookie },
        body: JSON.stringify({ email, role: "member" }),
      })).status).toBe(201);
    }
    const over = await fetch(`${ctx.url}/admin/workspaces/${ctx.workspaceId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.ownerCookie },
      body: JSON.stringify({ email: "s6@acme.test", role: "member" }),
    });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: "seat_limit" });

    const open = await fetch(`${ctx.url}/edge/workspaces/${ctx.workspaceId}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.memberCookie },
      body: JSON.stringify({ role: "owner" }),
    });
    expect(open.status).toBe(200);
    const body = await open.json() as { role: string; scopes?: string[] };
    expect(body.role).toBe("member");
    expect(body.scopes).toEqual(["client"]);
  } finally {
    await ctx.close();
  }
});

it("remove member revokes sessions and calls member-left; sleep refused on team", async () => {
  const ctx = await bootTeam();
  try {
    const me = await (await fetch(`${ctx.url}/edge/me`, { headers: { cookie: ctx.memberCookie } })).json() as {
      account: { id: string };
    };
    const sleep = await fetch(`${ctx.url}/admin/workspaces/${ctx.workspaceId}/sleep`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.ownerCookie },
      body: "{}",
    });
    expect(sleep.status).toBe(409);
    expect(await sleep.json()).toMatchObject({ busy: ["team"] });

    const removed = await fetch(`${ctx.url}/admin/workspaces/${ctx.workspaceId}/members/${me.account.id}`, {
      method: "DELETE",
      headers: { cookie: ctx.ownerCookie },
    });
    expect(removed.status).toBe(200);
    const body = await removed.json() as { memberLeft?: { ok?: boolean }; sessionsRevoked: number };
    expect(body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(body.memberLeft).toMatchObject({ ok: true });
    expect(ctx.memberLeftEmails).toContain("member@acme.test");
    expect((await fetch(`${ctx.url}/edge/me`, { headers: { cookie: ctx.memberCookie } })).status).toBe(401);
  } finally {
    await ctx.close();
  }
});
