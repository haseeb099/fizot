import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { upstreamHostHits } from "./scan-upstream-hosts.mjs";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fizot-host-"));
  writeFileSync(join(root, "package.json"), '{ "name": "fizot", "homepage": "https://example.com" }\n');
  mkdirSync(join(root, "server"));
  return root;
}

it("accepts a clean fixture and rejects a seeded host (FB-U)", async () => {
  const clean = fixture();
  writeFileSync(join(clean, "server", "app.ts"), 'const url = "https://localhost:8787";\n');
  expect(await upstreamHostHits(clean, [])).toEqual([]);

  const leak = fixture();
  writeFileSync(join(leak, "server", "leak.ts"), 'const url = "https://openmausbot.com/update";\n');
  const hits = await upstreamHostHits(leak, []);
  expect(hits.map((hit) => `${hit.file}:${hit.line}`)).toEqual(["server/leak.ts:1"]);
  expect(await upstreamHostHits(leak, [{ host: "openmausbot.com", reason: "Named in the test." }])).toEqual([]);
});

it("the static CI job runs the host scan (FB-I)", () => {
  const yaml = readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
  expect(yaml).toContain("node scripts/fizot/scan-upstream-hosts.mjs");
});

it("finds no unlisted upstream host in this repo", async () => {
  const root = join(import.meta.dirname, "..", "..");
  expect(await upstreamHostHits(root, allowEntries("allowed-hosts.json"))).toEqual([]);
});

function allowEntries(name: string): { host?: string; path?: string; reason: string }[] {
  const parsed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "brand", name), "utf8")) as { entries: { host?: string; path?: string; reason: string }[] };
  return parsed.entries;
}
