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
  const prevWebhook = process.env.FIZOT_ALERT_WEBHOOK_URL;
  delete process.env.ADMIN_DATABASE_URL;
  process.env.NODE_ENV = "production";
  delete process.env.FIZOT_ENV;
  process.env.FIZOT_ALERT_WEBHOOK_URL = "https://alerts.example/hook";
  try {
    await expect(createAdminServer({ auth: new UnconfiguredAuthProvider() })).rejects.toThrow(/ADMIN_DATABASE_URL/);
  } finally {
    process.env.NODE_ENV = prevNode;
    if (prevFizot === undefined) delete process.env.FIZOT_ENV;
    else process.env.FIZOT_ENV = prevFizot;
    if (prevDb === undefined) delete process.env.ADMIN_DATABASE_URL;
    else process.env.ADMIN_DATABASE_URL = prevDb;
    if (prevWebhook === undefined) delete process.env.FIZOT_ALERT_WEBHOOK_URL;
    else process.env.FIZOT_ALERT_WEBHOOK_URL = prevWebhook;
  }
});

it("production mode without an alert channel refuses to start", async () => {
  const prevNode = process.env.NODE_ENV;
  const prevFizot = process.env.FIZOT_ENV;
  const prevWebhook = process.env.FIZOT_ALERT_WEBHOOK_URL;
  const prevSecret = process.env.FIZOT_ALERT_WEBHOOK_SECRET;
  const prevToken = process.env.GITHUB_TOKEN;
  const prevRepo = process.env.GITHUB_REPOSITORY;
  const prevAlertRepo = process.env.FIZOT_ALERT_GITHUB_REPO;
  process.env.NODE_ENV = "production";
  delete process.env.FIZOT_ENV;
  delete process.env.FIZOT_ALERT_WEBHOOK_URL;
  delete process.env.FIZOT_ALERT_WEBHOOK_SECRET;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.FIZOT_ALERT_GITHUB_REPO;
  try {
    await expect(createAdminServer({ auth: new UnconfiguredAuthProvider() })).rejects.toThrow(/alert channel/);
  } finally {
    process.env.NODE_ENV = prevNode;
    if (prevFizot === undefined) delete process.env.FIZOT_ENV;
    else process.env.FIZOT_ENV = prevFizot;
    if (prevWebhook === undefined) delete process.env.FIZOT_ALERT_WEBHOOK_URL;
    else process.env.FIZOT_ALERT_WEBHOOK_URL = prevWebhook;
    if (prevSecret === undefined) delete process.env.FIZOT_ALERT_WEBHOOK_SECRET;
    else process.env.FIZOT_ALERT_WEBHOOK_SECRET = prevSecret;
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
    if (prevRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = prevRepo;
    if (prevAlertRepo === undefined) delete process.env.FIZOT_ALERT_GITHUB_REPO;
    else process.env.FIZOT_ALERT_GITHUB_REPO = prevAlertRepo;
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
