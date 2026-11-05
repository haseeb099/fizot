/**
 * Gate G0b: staging Fly org must be the real slug "fizot", never the
 * placeholder "fizot-staging" that 404s on Fly's /v1/apps.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DEFAULT_FLY_ORG, resolveFlyOrg } from "../../../server/fizot/admin/public.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "artifacts" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

it("DEFAULT_FLY_ORG is fizot and resolveFlyOrg falls back to it", () => {
  expect(DEFAULT_FLY_ORG).toBe("fizot");
  expect(resolveFlyOrg(undefined, {})).toBe("fizot");
  expect(resolveFlyOrg("", {})).toBe("fizot");
  expect(resolveFlyOrg(undefined, { FLY_ORG: "  acme  " })).toBe("acme");
  expect(resolveFlyOrg("override", { FLY_ORG: "acme" })).toBe("override");
});

it("no fizot-staging string remains in workflows or Fly staging scripts", () => {
  const roots = [
    path.join(ROOT, ".github", "workflows"),
    path.join(ROOT, "scripts", "fizot"),
    path.join(ROOT, "server", "fizot", "admin"),
  ];
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      if (!/\.(ya?ml|mjs|ts|md)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("fizot-staging")) {
        hits.push(path.relative(ROOT, file).replaceAll("\\", "/"));
      }
    }
  }
  expect(hits, `leftover fizot-staging in:\n${hits.join("\n")}`).toEqual([]);
});
