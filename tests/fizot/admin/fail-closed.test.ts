import { expect, it } from "vitest";
import {
  createAdminServer,
  FakeAuthProvider,
  isProductionAdminEnv,
  resolveAdminAuth,
  UnconfiguredAuthProvider,
} from "../../../server/fizot/admin/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/fizot/admin/auth.ts";

it("resolveAdminAuth defaults to Unconfigured outside test; Fake only in test or when passed", () => {
  expect(resolveAdminAuth({ nodeEnv: "production" }).auth).toBeInstanceOf(UnconfiguredAuthProvider);
  expect(resolveAdminAuth({ nodeEnv: "production" }).allowFakeSignIn).toBe(false);
  expect(resolveAdminAuth({ nodeEnv: "development" }).auth).toBeInstanceOf(UnconfiguredAuthProvider);
  expect(resolveAdminAuth({ nodeEnv: "test" }).auth).toBeInstanceOf(FakeAuthProvider);
  expect(resolveAdminAuth({ nodeEnv: "test" }).allowFakeSignIn).toBe(true);
  const explicit = resolveAdminAuth({ auth: new FakeAuthProvider(), nodeEnv: "production" });
  expect(explicit.auth).toBeInstanceOf(FakeAuthProvider);
  expect(explicit.allowFakeSignIn).toBe(true);
  const locked = resolveAdminAuth({ auth: new UnconfiguredAuthProvider(), nodeEnv: "test" });
  expect(locked.allowFakeSignIn).toBe(false);
});

it("isProductionAdminEnv is true for NODE_ENV or FIZOT_ENV production", () => {
  expect(isProductionAdminEnv({ NODE_ENV: "production" })).toBe(true);
  expect(isProductionAdminEnv({ FIZOT_ENV: "production" })).toBe(true);
  expect(isProductionAdminEnv({ NODE_ENV: "test" })).toBe(false);
});

it("default / fail-closed server: fake-sign-in returns 404 and no session cookie", async () => {
  const admin = await createAdminServer({
    auth: new UnconfiguredAuthProvider(),
    allowFakeSignIn: false,
  });
  try {
    const res = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !c.includes("Max-Age=0"))).toBe(false);
  } finally {
    await admin.close();
  }
});

it("production mode without ADMIN_DATABASE_URL refuses to start", async () => {
  const prevNode = process.env.NODE_ENV;
  const prevFizot = process.env.FIZOT_ENV;
  const prevDb = process.env.ADMIN_DATABASE_URL;
  delete process.env.ADMIN_DATABASE_URL;
  process.env.NODE_ENV = "production";
  delete process.env.FIZOT_ENV;
  try {
    await expect(createAdminServer({ auth: new UnconfiguredAuthProvider() })).rejects.toThrow(/ADMIN_DATABASE_URL/);
  } finally {
    process.env.NODE_ENV = prevNode;
    if (prevFizot === undefined) delete process.env.FIZOT_ENV;
    else process.env.FIZOT_ENV = prevFizot;
    if (prevDb === undefined) delete process.env.ADMIN_DATABASE_URL;
    else process.env.ADMIN_DATABASE_URL = prevDb;
  }
});

it("default cookie has Secure", async () => {
  const admin = await createAdminServer({ auth: new FakeAuthProvider() });
  try {
    const res = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "secure@example.com" }),
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie?.() ?? [];
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(session).toBeTruthy();
    expect(session!.toLowerCase().split(";").map((p) => p.trim())).toContain("secure");
  } finally {
    await admin.close();
  }
});
