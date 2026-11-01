import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { enterpriseImportHits } from "./guard-enterprise-imports.mjs";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "fizot-guard-"));
}

it("accepts a clean tree and rejects a seeded import (FB-U)", async () => {
  const clean = fixture();
  writeFileSync(join(clean, "app.ts"), 'import { editionStatus } from "./enterprise.ts";\n// enterprise/server/workspace-access.ts\nconst include = ["enterprise/**/*.test.ts"];\n');
  mkdirSync(join(clean, "server"));
  writeFileSync(join(clean, "server", "enterprise.ts"), 'await import(new URL("../enterprise/server/index.ts", import.meta.url).href);\n');
  expect(await enterpriseImportHits(clean)).toEqual([]);

  const leak = fixture();
  const specifier = "../enterprise/" + "server/index.ts";
  writeFileSync(join(leak, "leak.ts"), "import { register } from " + JSON.stringify(specifier) + ";\n");
  expect(await enterpriseImportHits(leak)).toEqual([`leak.ts: ${specifier}`]);
});

it("the static CI job runs the guard (FB-I)", () => {
  const yaml = readFileSync(join(fileRoot(), ".github", "workflows", "ci.yml"), "utf8");
  expect(yaml).toContain("node scripts/fizot/guard-enterprise-imports.mjs");
});

it("finds no enterprise import in this repo", async () => {
  const root = fileRoot();
  expect(await enterpriseImportHits(root)).toEqual([]);
});

function fileRoot(): string {
  return join(import.meta.dirname, "..", "..");
}
