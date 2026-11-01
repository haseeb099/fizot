import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeEnterpriseTrees } from "./remove-enterprise.mjs";

const script = fileURLToPath(new URL("./remove-enterprise.mjs", import.meta.url));

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fizot-remove-"));
  for (const relative of ["enterprise/server", "cloudflare/control-plane", "apps/docs", ".tmpexp"]) {
    mkdirSync(join(root, relative), { recursive: true });
    writeFileSync(join(root, relative, "marker.txt"), "x");
  }
  writeFileSync(join(root, "LICENSE"), "apache\n");
  writeFileSync(join(root, "pnpm-workspace.yaml"), [
    "packages:",
    '  - "."',
    '  - "apps/docs"',
    '  - "cloudflare/control-plane"',
    "supportedArchitectures:",
    "  cpu:",
    "    - x64",
    "",
  ].join("\n"));
  return root;
}

it("removes the four trees and the workspace entries, then changes nothing (FB-U)", async () => {
  const root = fixture();
  const first = await removeEnterpriseTrees(root);
  expect(first).toEqual([
    "enterprise/",
    "cloudflare/control-plane/",
    "apps/docs/",
    ".tmpexp/",
    'pnpm-workspace.yaml - "apps/docs"',
    'pnpm-workspace.yaml - "cloudflare/control-plane"',
  ]);
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toBe("apache\n");
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  expect(yaml).toBe('packages:\n  - "."\nsupportedArchitectures:\n  cpu:\n    - x64\n');
  expect(await removeEnterpriseTrees(root)).toEqual([]);
  expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(yaml);
});

it("refuses to touch a licence file and deletes nothing", () => {
  const root = fixture();
  const result = spawnSync(process.execPath, [script, "--root", root, "LICENSE"], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("refusing to touch LICENSE");
  expect(readFileSync(join(root, "LICENSE"), "utf8")).toBe("apache\n");
  expect(readFileSync(join(root, "enterprise", "server", "marker.txt"), "utf8")).toBe("x");
});
