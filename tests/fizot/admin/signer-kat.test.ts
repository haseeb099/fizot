import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { adminRequestSignature } from "../../../server/fizot/admin/public.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts/fizot/independent-hmac-kat.mjs");

it("matches the independent node:crypto known-answer HMAC (no circular import)", () => {
  const ran = spawnSync(process.execPath, [SCRIPT, "--json"], { encoding: "utf8" });
  expect(ran.status, ran.stderr || ran.stdout).toBe(0);
  const vector = JSON.parse(ran.stdout) as {
    secret: string;
    timestamp: string;
    nonce: string;
    method: string;
    target: string;
    body: string;
    signature: string;
  };
  const fromAdmin = adminRequestSignature(
    vector.secret,
    vector.timestamp,
    vector.nonce,
    vector.method,
    vector.target,
    vector.body,
  );
  expect(fromAdmin).toBe(vector.signature);
  expect(vector.signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
