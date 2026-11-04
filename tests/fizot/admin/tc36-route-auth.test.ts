import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  AUTHORIZE_HELPER_ID,
  authorizeWorkspaceAccess,
  publicRouteIds,
  ROUTE_REGISTRY,
} from "../../../server/fizot/admin/public.ts";
import { createAdminServer } from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function cookieFrom(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  const hit = raw.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!hit) return null;
  return hit.split(";")[0] ?? null;
}

it("TC36: every registered route is public allow-list or authorize-covered", () => {
  const routesSource = readFileSync(path.join(ROOT, "server/fizot/admin/routes.ts"), "utf8");
  const registrySource = readFileSync(path.join(ROOT, "server/fizot/admin/route-registry.ts"), "utf8");

  expect(authorizeWorkspaceAccess).toHaveProperty("helperId", AUTHORIZE_HELPER_ID);
  expect(routesSource).toContain("authorizeWorkspaceAccess");
  expect(routesSource).toContain("matchRoute");
  expect(registrySource).toContain("ROUTE_REGISTRY");

  const publicIds = new Set(publicRouteIds());
  expect(publicIds.size).toBeGreaterThan(0);

  const swept: string[] = [];
  for (const route of ROUTE_REGISTRY) {
    swept.push(`${route.method} ${route.path} auth=${route.auth}`);
    expect(["public", "session", "membership"]).toContain(route.auth);
    if (route.auth === "public") {
      expect(publicIds.has(route.id)).toBe(true);
    }
    if (route.auth === "membership") {
      expect(route.path).toContain(":workspaceId");
      expect(route.minRole).toBeTruthy();
      expect(routesSource).toContain(`case "${route.id}"`);
    }
    if (route.auth === "session") {
      expect(routesSource).toContain(`case "${route.id}"`);
    }
  }

  // Every switch case id in routes must appear in the registry (no shadow routes).
  const caseIds = [...routesSource.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
  const registryIds = new Set(ROUTE_REGISTRY.map((r) => r.id));
  for (const id of caseIds) {
    expect(registryIds.has(id), `handler case ${id} missing from ROUTE_REGISTRY`).toBe(true);
  }

  // eslint-disable-next-line no-console
  console.log(`TC36 swept ${ROUTE_REGISTRY.length} routes:\n${swept.join("\n")}`);
});

it("TC36 runtime: unauthenticated membership routes return 401; public stay open", async () => {
  const admin = await createAdminServer({ cookieSecure: false });
  try {
    for (const route of ROUTE_REGISTRY) {
      const pathFilled = route.path.replace(":workspaceId", "ws-missing");
      const body =
        route.method === "GET" || route.method === "DELETE"
          ? undefined
          : route.id === "edge.fakeSignIn"
            ? JSON.stringify({ email: "tc36-public@example.com" })
            : "{}";
      const res = await fetch(`${admin.url}${pathFilled}`, {
        method: route.method,
        headers: route.method === "GET" ? undefined : { "content-type": "application/json" },
        body,
      });
      if (route.auth === "public") {
        expect(res.status, `${route.id} should be reachable`).not.toBe(401);
      } else {
        expect(res.status, `${route.id} must require session`).toBe(401);
      }
    }
  } finally {
    await admin.close();
  }
});

it("TC36: session can reach list; membership without row is 404 not 403", async () => {
  const admin = await createAdminServer({ cookieSecure: false });
  try {
    const signIn = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "tc36@example.com" }),
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieFrom(signIn);
    expect(cookie).toBeTruthy();

    const list = await fetch(`${admin.url}/admin/workspaces`, { headers: { cookie: cookie! } });
    expect(list.status).toBe(200);

    const ghost = await fetch(`${admin.url}/admin/workspaces/does-not-exist/power`, {
      headers: { cookie: cookie! },
    });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: "not_found" });
  } finally {
    await admin.close();
  }
});
