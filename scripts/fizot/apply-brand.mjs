import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTextFiles } from "./scan-text.mjs";

const ROOTS = ["server", "src", "shared", "electron", "companion", "public", "scripts", "docs", "package.json", "index.html"];
const SKIP = new Set([
  "LICENSE",
  "NOTICE",
  "LICENSING.md",
  "CLA.md",
  "docs/CHANGELOG.md",
  "docs/PATCH_REGISTRY.md",
  "src/locales/vocabulary.test.ts",
  "scripts/fizot/scan-brand-leaks.mjs",
  "scripts/fizot/scan-brand-leaks.test.ts",
  "scripts/fizot/scan-upstream-hosts.mjs",
  "scripts/fizot/scan-upstream-hosts.test.ts",
  "scripts/fizot/scan-text.mjs",
  "scripts/fizot/apply-brand.mjs",
]);

export function loadBrandMap(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.replace) || parsed.replace.some((row) => !Array.isArray(row) || row.length !== 2 || !row[0] || !row[1])) {
    throw new Error(`${file} needs replace pairs`);
  }
  return parsed;
}

const WHOLE = new Set(["md", "html", "svg", "json", "webmanifest", "yml", "yaml", "txt", "css"]);

function replacePairs(text, pairs) {
  let next = text;
  for (const [from, to] of pairs) next = next.replaceAll(from, to);
  return next;
}

export function applyBrandText(text, pairs, file) {
  if (!pairs.some(([from]) => text.includes(from))) return text;
  const ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "";
  if (WHOLE.has(ext) || file.endsWith(".webmanifest")) return replacePairs(text, pairs);
  let out = "";
  let index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (quote === "\"" || quote === "'" || quote === "`") {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") { end += 2; continue; }
        if (text[end] === quote) { end += 1; break; }
        end += 1;
      }
      out += replacePairs(text.slice(index, end), pairs);
      index = end;
      continue;
    }
    if (quote === ">") {
      const end = text.indexOf("<", index + 1);
      if (end !== -1 && end - index < 400) {
        out += replacePairs(text.slice(index, end + 1), pairs);
        index = end + 1;
        continue;
      }
    }
    out += quote;
    index += 1;
  }
  return out;
}

export async function applyBrandTree(root, map) {
  const changed = [];
  for (const file of await readTextFiles(root, ROOTS)) {
    if (SKIP.has(file.file)) continue;
    const next = applyBrandText(file.text, map.replace, file.file);
    if (next === file.text) continue;
    writeFileSync(path.join(root, file.file), next);
    changed.push(file.file);
  }
  return changed;
}

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const map = loadBrandMap(path.join(repoRoot, "brand/brand-map.json"));
  const changed = await applyBrandTree(repoRoot, map);
  console.log(`brand map applied to ${changed.length} files`);
}
