import { expect, it } from "vitest";
import {
  mayChangeMemberRole,
  mayTransferOwnership,
  createFakeFlyClient,
  createMemoryNonceStore,
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

it("mayTransferOwnership: refuses self; requires actor owner; target not already owner", () => {
  expect(mayTransferOwnership({ actorRole: "owner", targetRole: "admin", targetIsSelf: true }).ok).toBe(false);
  expect(mayTransferOwnership({ actorRole: "admin", targetRole: "member", targetIsSelf: false }).ok).toBe(false);
  expect(mayTransferOwnership({ actorRole: "owner", targetRole: "owner", targetIsSelf: false }).ok).toBe(false);
  expect(mayTransferOwnership({ actorRole: "owner", targetRole: "admin", targetIsSelf: false }).ok).toBe(true);
});

it("self-demote without transfer is refused (owner_locked / transfer_required)", () => {
  const selfDemote = mayChangeMemberRole({
    actorRole: "owner",
    targetRole: "owner",
    nextRole: "admin",
    targetIsSelf: true,
  });
  expect(selfDemote.ok).toBe(false);
  if (!selfDemote.ok) expect(selfDemote.error).toBe("owner_locked");
});

it("HTTP: ownership transfer leaves exactly one owner; self-demote refused", async () => {
  const admin = await createAdminServer({
    fly: createFakeFlyClient(),
    auth: new FakeAuthProvider(),
    cookieSecure: false,
    nonces: createMemoryNonceStore(),
  });
  try {
    const ownerCookie = await signIn(admin.url, "owner-xfer@example.com");
    const adminCookie = await signIn(admin.url, "admin-xfer@example.com");

    const created = await fetch(`${admin.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ plan: "team", ownerEmail: "owner-xfer@example.com", teamId: "t-xfer", teamName: "Xfer" }),
    });
    expect(created.status).toBe(201);
    const wsId = (await created.json() as { workspace: { id: string } }).workspace.id;

    const inv = await fetch(`${admin.url}/admin/workspaces/${wsId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ email: "admin-xfer@example.com", role: "admin" }),
    });
    expect(inv.status).toBe(201);
    const token = (await inv.json() as { token: string }).token;
    expect((await fetch(`${admin.url}/edge/invites/${token}/accept`, {
      method: "POST",
      headers: { cookie: adminCookie },
    })).status).toBe(200);

    const members = await (await fetch(`${admin.url}/admin/workspaces/${wsId}/members`, {
      headers: { cookie: ownerCookie },
    })).json() as { members: Array<{ accountId: string; email: string; role: string }> };
    const ownerRow = members.members.find((m) => m.email === "owner-xfer@example.com")!;
    const adminRow = members.members.find((m) => m.email === "admin-xfer@example.com")!;

    const selfDemote = await fetch(`${admin.url}/admin/workspaces/${wsId}/members/${ownerRow.accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(selfDemote.status).toBe(409);
    expect((await selfDemote.json() as { error: string }).error).toMatch(/owner_locked|transfer_required/);

    const afterSelf = await (await fetch(`${admin.url}/admin/workspaces/${wsId}/members`, {
      headers: { cookie: ownerCookie },
    })).json() as { members: Array<{ role: string }> };
    expect(afterSelf.members.filter((m) => m.role === "owner")).toHaveLength(1);

    const transfer = await fetch(`${admin.url}/admin/workspaces/${wsId}/members/${adminRow.accountId}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ role: "owner" }),
    });
    expect(transfer.status).toBe(200);

    const after = await (await fetch(`${admin.url}/admin/workspaces/${wsId}/members`, {
      headers: { cookie: adminCookie },
    })).json() as { members: Array<{ email: string; role: string }> };
    expect(after.members.filter((m) => m.role === "owner")).toHaveLength(1);
    expect(after.members.find((m) => m.email === "admin-xfer@example.com")?.role).toBe("owner");
    expect(after.members.find((m) => m.email === "owner-xfer@example.com")?.role).toBe("admin");
  } finally {
    await admin.close();
  }
});
