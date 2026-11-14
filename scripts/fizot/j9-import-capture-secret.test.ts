import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const importer = resolve(process.cwd(), "scripts/fizot/j9-import-capture-secret.mjs");
const roots: string[] = [];
const pathParts = ["artifacts", "j9", "webhook-capture.json"] as const;

function execute(raw?: string) {
  const root = mkdtempSync(join(tmpdir(), "fizot-j9-capture-secret-"));
  roots.push(root);
  const env = { ...process.env };
  delete env.STRIPE_J9_CAPTURE_JSON;
  if (raw !== undefined) env.STRIPE_J9_CAPTURE_JSON = raw;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", importer], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return { run, path: join(root, ...pathParts) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validCapture() {
  return JSON.stringify({
    schemaVersion: 2,
    kind: "stripe_cli_signed_capture",
    runId: "j9run_abc123",
    capturedAt: new Date().toISOString(),
    deliveries: [
      {
        body: JSON.stringify({ id: "evt_example", object: "event", type: "invoice.paid" }),
        stripeSignatureHeader: "t=1794621163,v1=synthetic_for_transport_test",
        provenance: "stripe_cli_listen",
      },
    ],
  });
}

it("imports only the temporary encrypted-secret value to the restricted capture path", () => {
  const secret = validCapture();
  const { run, path } = execute(secret);
  expect(run.status).toBe(0);
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).runId).toBe("j9run_abc123");
  expect(run.stdout).not.toContain(secret);
  expect(run.stderr).not.toContain(secret);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("fails closed without a temporary secret and never creates a capture", () => {
  const { run, path } = execute();
  expect(run.status).toBe(2);
  expect(existsSync(path)).toBe(false);
});

it("fails closed on invalid capture JSON without printing its value", () => {
  const bad = "not-valid-json-sensitive-payload";
  const { run, path } = execute(bad);
  expect(run.status).toBe(2);
  expect(existsSync(path)).toBe(false);
  expect(run.stdout + run.stderr).not.toContain(bad);
});

it("rejects a capture containing prohibited key material", () => {
  const parsed = JSON.parse(validCapture());
  parsed.deliveries[0].body = "sk_test_forbidden_material";
  const raw = JSON.stringify(parsed);
  const { run, path } = execute(raw);
  expect(run.status).toBe(2);
  expect(existsSync(path)).toBe(false);
  expect(run.stdout + run.stderr).not.toContain(raw);
});

it("rejects an oversized capture secret without creating a file", () => {
  const { run, path } = execute("x".repeat(48 * 1024 + 1));
  expect(run.status).toBe(2);
  expect(existsSync(path)).toBe(false);
});
