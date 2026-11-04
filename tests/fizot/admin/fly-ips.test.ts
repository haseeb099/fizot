import { expect, it } from "vitest";
import { createFakeFlyClient, createFlyMachinesClient } from "../../../server/fizot/admin/public.ts";
import { describeFetchError } from "../../../server/fizot/admin/public.ts";

it("fake allocateIps records the call after createApp", async () => {
  const fly = createFakeFlyClient();
  await fly.createApp({ appName: "fizot-cm-test", org: "fizot", network: "net-1" });
  const ips = await fly.allocateIps("fizot-cm-test");
  expect(fly.calls).toContain("allocateIps:fizot-cm-test");
  expect(ips.via).toBe("fake");
  expect(ips.v4).toBeTruthy();
  expect(ips.v6).toBeTruthy();
});

it("real client tries Machines ip_assignments for shared_v4 and v6", async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.includes("/ip_assignments")) {
      return new Response(JSON.stringify({
        ip: body?.type === "shared_v4" ? "66.241.1.2" : "2a09:8280::1",
        shared: body?.type === "shared_v4",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;

  const fly = createFlyMachinesClient({
    token: "test-token-not-real",
    org: "fizot",
    fetchImpl,
    printCost: false,
  });
  const ips = await fly.allocateIps("fizot-cm-demo");
  expect(ips.via).toBe("machines");
  expect(ips.v4).toBe("66.241.1.2");
  expect(ips.v6).toBe("2a09:8280::1");
  const assignments = calls.filter((c) => c.url.includes("/ip_assignments"));
  expect(assignments).toHaveLength(2);
  expect(assignments.map((c) => c.body)).toEqual([{ type: "shared_v4" }, { type: "v6" }]);
  expect(assignments.every((c) => c.method === "POST")).toBe(true);
  expect(assignments.every((c) => c.url.includes("/v1/apps/fizot-cm-demo/ip_assignments"))).toBe(true);
});

it("real client falls back to GraphQL when ip_assignments is unavailable", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("api.machines.dev") && url.includes("/ip_assignments")) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (url.includes("api.fly.io/graphql")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const type = body?.variables?.input?.type;
      return new Response(JSON.stringify({
        data: {
          allocateIpAddress: {
            ipAddress: { address: type === "shared_v4" ? "66.241.9.9" : "2a09:8280::9", type },
            app: { sharedIpAddress: "66.241.9.9" },
          },
        },
      }), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  const fly = createFlyMachinesClient({
    token: "test-token-not-real",
    org: "fizot",
    fetchImpl,
    printCost: false,
  });
  const ips = await fly.allocateIps("fizot-cm-gql");
  expect(ips.via).toBe("graphql");
  expect(ips.v4).toBe("66.241.9.9");
  expect(ips.v6).toBe("2a09:8280::9");
  expect(calls.some((u) => u.includes("/ip_assignments"))).toBe(true);
  expect(calls.filter((u) => u.includes("api.fly.io/graphql"))).toHaveLength(2);
});

it("describeFetchError includes undici cause code and hostname", () => {
  const err = Object.assign(new Error("fetch failed"), {
    cause: { code: "ENOTFOUND", hostname: "fizot-cm-x.fly.dev" },
  });
  expect(describeFetchError(err)).toContain("fetch failed");
  expect(describeFetchError(err)).toContain("code=ENOTFOUND");
  expect(describeFetchError(err)).toContain("hostname=fizot-cm-x.fly.dev");
});
