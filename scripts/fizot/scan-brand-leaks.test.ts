import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { brandLeakHits } from "./scan-brand-leaks.mjs";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fizot-brand-"));
  writeFileSync(join(root, "package.json"), '{ "name": "fizot", "description": "A private fork." }\n');
  mkdirSync(join(root, "server"));
  return root;
}

it("accepts a clean fixture and rejects a seeded brand leak (FB-U)", async () => {
  const clean = fixture();
  writeFileSync(join(clean, "server", "app.ts"), 'const title = "Fizot";\n');
  expect(await brandLeakHits(clean, [])).toEqual([]);

  const leak = fixture();
  writeFileSync(join(leak, "server", "leak.ts"), 'const title = "OpenMausBot";\n');
  writeFileSync(join(leak, "LICENSE"), "Apache-2.0. The upstream name is OpenMausBot.\n");
  const hits = await brandLeakHits(leak, []);
  expect(hits.map((hit) => `${hit.file}:${hit.line}`).sort()).toEqual(["LICENSE:1", "server/leak.ts:1"]);
  const allowed = await brandLeakHits(leak, [{ path: "LICENSE", reason: "Attribution." }]);
  expect(allowed.map((hit) => `${hit.file}:${hit.line}`)).toEqual(["server/leak.ts:1"]);
});

it("the static CI job runs the brand scan (FB-I)", () => {
  const yaml = readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  expect(yaml).toContain("node scripts/fizot/scan-brand-leaks.mjs");
});

it("finds no unlisted brand leak in this repo", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const parsed = JSON.parse(readFileSync(join(root, "brand", "allowed-brand.json"), "utf8")) as { entries: { path?: string; reason: string }[] };
  expect(await brandLeakHits(root, parsed.entries)).toEqual([]);
});
