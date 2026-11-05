/**
 * J10 (daily gate / fakes): private chats stay private; Admin metadata only;
 * no Admin/Edge route proxies chat content; redaction covers chat fields.
 */
import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  createFakeFlyClient,
  createMemoryNonceStore,
  redactForLog,
  ROUTE_REGISTRY,
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

it("redacts private-chat content keys from logs", () => {
  const redacted = redactForLog({
    messages: [{ text: "secret bee plans" }],
    privateChat: "Kumquat Labs",
    threadBody: "interview next week",
    bootstrapSecret: "abc",
  }) as Record<string, unknown>;
  expect(JSON.stringify(redacted)).not.toContain("Kumquat");
  expect(JSON.stringify(redacted)).not.toContain("bee plans");
  expect(redacted.bootstrapSecret).toBe("[redacted]");
});

it("J10 fake: member A private chat invisible to B and Admin; removal deletes it; sleep refused", async () => {
  type Chat = { id: string; ownerEmail: string; private: true; title: string; text: string };
  const chats = new Map<string, Chat>();
  const machine = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://m.local");
    const auth = String(req.headers["x-fizot-member-email"] ?? "");
    if (url.pathname === "/api/cloud/team/member-left" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const email = JSON.parse(Buffer.concat(chunks).toString("utf8")).email as string;
        for (const [id, chat] of chats) {
          if (chat.ownerEmail === email) chats.delete(id);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, chats: 1 }));
      });
      return;
    }
    if (url.pathname === "/api/cloud/pairing") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ credential: "omb_pair_j10" }));
      return;
    }
    if (url.pathname === "/api/cloud/power/sleep") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, busy: ["team"] }));
      return;
    }
    if (url.pathname.startsWith("/api/bots/") && url.pathname.endsWith("/tasks") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { title?: string };
        const id = `chat-${chats.size + 1}`;
        chats.set(id, { id, ownerEmail: auth, private: true, title: body.title ?? "private", text: "" });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ task: { id, threadId: id, private: true } }));
      });
      return;
    }
    if (url.pathname.startsWith("/api/threads/") && req.method === "GET") {
      const id = url.pathname.split("/")[3]!;
      const chat = chats.get(id);
      if (!chat || chat.ownerEmail !== auth) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [{ text: chat.text || "private words" }], private: true }));
      return;
    }
    if (url.pathname === "/api/bots" && req.method === "GET") {
      const mine = [...chats.values()].filter((c) => c.ownerEmail === auth).map((c) => ({
        id: "bot-1",
        tasks: [{ threadId: c.id, private: true as const, title: c.title }],
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bots: mine.length ? mine : [{ id: "bot-1", tasks: [] }] }));
      return;
    }
    if (url.pathname === "/api/cloud/team/admin") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        activity: [...chats.values()].map((c) => ({ kind: "chat", private: true, owner: c.ownerEmail, id: c.id })),
      }));
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

  try {
    const ownerCookie = await signIn(admin.url, "olive@acme.test");
    const created = await fetch(`${admin.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ plan: "team", teamId: "t1", teamName: "Acme", ownerEmail: "olive@acme.test" }),
    });
    expect(created.status).toBe(201);
    const wsId = (await created.json() as { workspace: { id: string; publicUrl: string } }).workspace.id;

    async function add(email: string, role: "admin" | "member") {
      const inv = await fetch(`${admin.url}/admin/workspaces/${wsId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ email, role }),
      });
      const token = (await inv.json() as { token: string }).token;
      const cookie = await signIn(admin.url, email);
      await fetch(`${admin.url}/edge/invites/${token}/accept`, { method: "POST", headers: { cookie } });
      return cookie;
    }
    const adminCookie = await add("ari@acme.test", "admin");
    const aCookie = await add("ada@acme.test", "member");
    const bCookie = await add("bob@acme.test", "member");

    // Simulate machine sessions via header after edge open (pairing scopes).
    const openA = await fetch(`${admin.url}/edge/workspaces/${wsId}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aCookie },
      body: "{}",
    });
    expect(openA.status).toBe(200);
    expect((await openA.json() as { scopes: string[] }).scopes).toEqual(["client"]);

    const makeChat = await fetch(`${origin}/api/bots/bot-1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fizot-member-email": "ada@acme.test" },
      body: JSON.stringify({ title: "Ada private" }),
    });
    expect(makeChat.status).toBe(201);
    const made = await makeChat.json() as { task: { threadId: string; private: boolean } };
    expect(made.task.private).toBe(true);
    const threadId = made.task.threadId;

    const aRead = await fetch(`${origin}/api/threads/${threadId}/messages`, {
      headers: { "x-fizot-member-email": "ada@acme.test" },
    });
    expect(aRead.status).toBe(200);
    expect((await aRead.json() as { private: boolean }).private).toBe(true);

    for (const email of ["bob@acme.test", "ari@acme.test", "olive@acme.test"]) {
      expect((await fetch(`${origin}/api/threads/${threadId}/messages`, {
        headers: { "x-fizot-member-email": email },
      })).status).toBe(404);
      const list = await (await fetch(`${origin}/api/bots`, {
        headers: { "x-fizot-member-email": email },
      })).json() as { bots: Array<{ tasks: Array<{ threadId: string }> }> };
      expect(list.bots.flatMap((b) => b.tasks).map((t) => t.threadId)).not.toContain(threadId);
    }

    const activity = await (await fetch(`${origin}/api/cloud/team/admin`)).json() as {
      activity: Array<{ private?: boolean; text?: string; messages?: unknown }>;
    };
    expect(activity.activity.every((row) => row.private === true && !("text" in row) && !("messages" in row))).toBe(true);

    const sleep = await fetch(`${admin.url}/admin/workspaces/${wsId}/sleep`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: "{}",
    });
    expect(sleep.status).toBe(409);

    const members = await (await fetch(`${admin.url}/admin/workspaces/${wsId}/members`, {
      headers: { cookie: adminCookie },
    })).json() as { members: Array<{ email: string; accountId: string }> };
    expect(members.members.every((m) => !("messages" in m) && !("privateChat" in m))).toBe(true);
    const ada = members.members.find((m) => m.email === "ada@acme.test")!;
    expect((await fetch(`${admin.url}/admin/workspaces/${wsId}/members/${ada.accountId}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    })).status).toBe(200);
    expect(chats.has(threadId)).toBe(false);

    // No Admin/Edge registry path accepts chat content fields as a first-class body contract.
    const chattyPaths = ROUTE_REGISTRY.filter((r) => /chat|message|thread/i.test(r.path));
    expect(chattyPaths).toEqual([]);
    void bCookie;
  } finally {
    await admin.close();
    await new Promise<void>((resolve, reject) => machine.close((e) => (e ? reject(e) : resolve())));
  }
});
