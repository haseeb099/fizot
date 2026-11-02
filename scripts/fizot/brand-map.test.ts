import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBrandText, loadBrandMap } from "./apply-brand.mjs";
import { brandLeakHits } from "./scan-brand-leaks.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function isUserVisible(file: string): boolean {
  if (file === "index.html" || file.startsWith("public/") || file.startsWith("companion/src/")) return true;
  if (file.startsWith("src/") && !file.endsWith(".test.ts") && !file.endsWith(".test.tsx")) return true;
  if (file.startsWith("electron/") && !file.includes("node-test") && !file.endsWith(".test.mjs")) return true;
  return false;
}

describe("brand map", () => {
  it("replaces every mapped product name and mascot label", () => {
    const map = loadBrandMap(path.join(root, "brand", "brand-map.json"));
    const sources = [
      ...map.replace.map((row: [string, string]) => row[0]),
      ...Object.keys(map.mascotLabels),
    ];
    const sample = sources.map((name) => `see ${name} here`).join("\n");
    const out = applyBrandText(sample, map.replace, "index.html");
    for (const [from] of map.replace) expect(out.includes(from)).toBe(false);
    expect(out.includes(map.productName)).toBe(true);
    for (const label of Object.values(map.mascotLabels)) expect(label).toBe(map.mascotLabel);
  });

  it("covers every user-visible string the brand scan still finds", async () => {
    const map = loadBrandMap(path.join(root, "brand", "brand-map.json"));
    const known = new Set<string>([
      ...map.replace.map((row: [string, string]) => row[0]),
      ...Object.keys(map.mascotLabels),
    ]);
    const hits = await brandLeakHits(root, []);
    const uncovered = hits.filter((hit) => isUserVisible(hit.file) && !known.has(hit.value));
    expect(uncovered).toEqual([]);
  });
});
