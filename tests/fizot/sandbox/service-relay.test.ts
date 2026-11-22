import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRequestAuth } from "../../../server/request-auth.ts";
import { SessionRegistry } from "../../../server/sessions.ts";
import {
  serviceRelayDenial,
  serviceRelayWriteRequired,
  slackRelayTokenFromEnv,
} from "../../../server/fizot/sandbox/service-relay.ts";

const RELAY = "fizot-relay-token-32chars-min!!";

function request(headers: Record<string, string>, method = "GET"): IncomingMessage {
  return { headers, method } as unknown as IncomingMessage;
}

it("marks Slack-capable mutating service routes as relay-required and leaves reads/internal open", () => {
  expect(serviceRelayWriteRequired("POST", "/api/bots/bot-1/tasks")).toBe(true);
  expect(serviceRelayWriteRequired("POST", "/api/bots/bot-1/messages/guarded")).toBe(true);
  expect(serviceRelayWriteRequired("DELETE", "/api/bots/bot-1/queue/q1")).toBe(true);
  expect(serviceRelayWriteRequired("GET", "/api/health")).toBe(false);
  expect(serviceRelayWriteRequired("GET", "/api/bots")).toBe(false);
  expect(serviceRelayWriteRequired("POST", "/api/internal/hook")).toBe(false);
});

it("fails closed when the relay token is missing, short, or mismatched", () => {
  expect(slackRelayTokenFromEnv({ OMB_SLACK_RELAY_TOKEN: "short" })).toBeNull();
  expect(slackRelayTokenFromEnv({ OMB_SLACK_RELAY_TOKEN: RELAY })).toBe(RELAY);
  expect(serviceRelayDenial({
    method: "POST",
    path: "/api/bots/b/tasks",
    bearer: undefined,
    relayToken: null,
  })).toMatch(/not configured/);
  expect(serviceRelayDenial({
    method: "POST",
    path: "/api/bots/b/tasks",
    bearer: "wrong",
    relayToken: RELAY,
  })).toMatch(/token required/);
  expect(serviceRelayDenial({
    method: "POST",
    path: "/api/bots/b/tasks",
    bearer: RELAY,
    relayToken: RELAY,
  })).toBeNull();
  expect(serviceRelayDenial({
    method: "GET",
    path: "/api/health",
    bearer: undefined,
    relayToken: null,
  })).toBeNull();
});

describe("service-trust auth requires the Slack relay bearer for writes", () => {
  let dir: string;
  let sessions: SessionRegistry;
  const cookieName = "omb_session_8799_env";
  const local = { host: "127.0.0.1:8799" };

  function check(method: string, path: string, options: {
    relay?: string | null;
    bearer?: string;
  } = {}) {
    return resolveRequestAuth(request({
      ...local,
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    }, method), {
      sessions,
      cookieName,
      streamPath: "/api/events",
      url: new URL(path, "http://x"),
      loopbackTrust: "service",
      slackRelayToken: options.relay === undefined ? null : options.relay,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fizot-relay-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("allows service-trust reads without a relay token", () => {
    expect(check("GET", "/api/health").auth).toEqual({ kind: "loopback", scopes: ["client"], trust: "service" });
    expect(check("GET", "/api/bots").auth?.trust).toBe("service");
  });

  it("blocks service-trust Slack writes without a configured relay token", () => {
    const denied = check("POST", "/api/bots/bot-1/tasks", { relay: null });
    expect(denied.auth).toBeNull();
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/relay token/);
  });

  it("admits Slack writes only with the matching relay bearer", () => {
    const denied = check("POST", "/api/bots/bot-1/messages/guarded", { relay: RELAY, bearer: "nope" });
    expect(denied.auth).toBeNull();
    expect(denied.status).toBe(403);

    const ok = check("POST", "/api/bots/bot-1/messages/guarded", { relay: RELAY, bearer: RELAY });
    expect(ok.auth).toEqual({ kind: "loopback", scopes: ["client"], trust: "service" });
  });
});
