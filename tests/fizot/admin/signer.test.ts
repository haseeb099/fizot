import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  ADMIN_NONCE_TTL_MS,
  ADMIN_SIGN_SKEW_S,
  adminRequestSignature,
  bodyHash,
  mintBootstrapSecret,
  signAdminRequest,
  verifyAdminRequest,
} from "../../../server/fizot/admin/public.ts";
import { createMemoryNonceStore } from "../../../server/fizot/admin/nonce-store.ts";
import { cloudRequestSignature } from "../../../server/cloud-home.ts";

const SECRET = mintBootstrapSecret();

it("matches the documented canonical HMAC vector shape", () => {
  const body = Buffer.from('{"label":"Fizot app (Cloud)","ttlSeconds":300}');
  const timestamp = "1790000000";
  const nonce = "n".repeat(16);
  const sig = adminRequestSignature(SECRET, timestamp, nonce, "POST", "/api/cloud/pairing", body);
  expect(sig).toBe(cloudRequestSignature(SECRET, timestamp, nonce, "POST", "/api/cloud/pairing", body));
  const expected = createHash("sha256").update(body).digest("base64url");
  expect(bodyHash(body)).toBe(expected);
  expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

it("rejects clock skew over 300 s", async () => {
  const nonces = createMemoryNonceStore();
  const body = "";
  const headers = await signAdminRequest({
    secret: SECRET,
    method: "GET",
    target: "/api/cloud/health?after=0",
    body,
    nonces,
    now: () => 1_790_000_000_000,
  });
  const stale = await verifyAdminRequest({
    secret: SECRET,
    ...{
      timestamp: headers["x-omb-cloud-timestamp"],
      nonce: headers["x-omb-cloud-nonce"],
      signature: headers["x-omb-cloud-signature"],
    },
    method: "GET",
    target: "/api/cloud/health?after=0",
    body,
    nonces: createMemoryNonceStore(),
    now: () => 1_790_000_000_000 + (ADMIN_SIGN_SKEW_S + 1) * 1000,
  });
  expect(stale).toEqual({ ok: false, error: "stale_request" });
});

it("rejects a replayed nonce within 10 minutes", async () => {
  const nonces = createMemoryNonceStore();
  const now = () => 1_790_000_000_000;
  const headers = await signAdminRequest({
    secret: SECRET,
    method: "GET",
    target: "/api/cloud/power",
    body: "",
    nonces: createMemoryNonceStore(),
    now,
  });
  const first = await verifyAdminRequest({
    secret: SECRET,
    timestamp: headers["x-omb-cloud-timestamp"],
    nonce: headers["x-omb-cloud-nonce"],
    signature: headers["x-omb-cloud-signature"],
    method: "GET",
    target: "/api/cloud/power",
    body: "",
    nonces,
    now,
  });
  expect(first).toEqual({ ok: true });
  const replay = await verifyAdminRequest({
    secret: SECRET,
    timestamp: headers["x-omb-cloud-timestamp"],
    nonce: headers["x-omb-cloud-nonce"],
    signature: headers["x-omb-cloud-signature"],
    method: "GET",
    target: "/api/cloud/power",
    body: "",
    nonces,
    now,
  });
  expect(replay).toEqual({ ok: false, error: "replayed_request" });
  expect(ADMIN_NONCE_TTL_MS).toBe(10 * 60_000);
});

it("allows a fresh nonce after the previous reservation", async () => {
  const nonces = createMemoryNonceStore();
  const now = () => 1_790_000_000_000;
  const headers = await signAdminRequest({
    secret: SECRET,
    method: "POST",
    target: "/api/cloud/pairing",
    body: "{}",
    nonces: createMemoryNonceStore(),
    now,
  });
  const ok = await verifyAdminRequest({
    secret: SECRET,
    timestamp: headers["x-omb-cloud-timestamp"],
    nonce: headers["x-omb-cloud-nonce"],
    signature: headers["x-omb-cloud-signature"],
    method: "POST",
    target: "/api/cloud/pairing",
    body: "{}",
    nonces,
    now,
  });
  expect(ok).toEqual({ ok: true });
  const replay = await verifyAdminRequest({
    secret: SECRET,
    timestamp: headers["x-omb-cloud-timestamp"],
    nonce: headers["x-omb-cloud-nonce"],
    signature: headers["x-omb-cloud-signature"],
    method: "POST",
    target: "/api/cloud/pairing",
    body: "{}",
    nonces,
    now,
  });
  expect(replay).toEqual({ ok: false, error: "replayed_request" });
});
