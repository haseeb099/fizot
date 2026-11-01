import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowMatches, formatHit, patternHits, readTextFiles } from "./scan-text.mjs";

const ROOTS = ["server", "src", "shared", "electron", "companion", "public", "scripts", "docs", "dist", "dist-server", "package.json", "index.html", "LICENSE", "NOTICE", "LICENSING.md", "CLA.md"];

const PRODUCT = /\b(?:OpenMausBot|Open Maus|MausBot|Supamaus)\b/g;
// Display names from shared/mascot-bodies.ts. They are user-visible in the picker.
const MASCOT = /\b(?:Cursor|Blob|Squircle|Capsule|Hexagon|Diamond|Circle|Drop|Shield|Star)\b/g;
const MASCOT_SURFACE = /^(?:package\.json|index\.html|public\/|docs\/|src\/locales\/|electron\/)/;

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function loadAllowList(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry.reason !== "string" || entry.reason.length === 0)) {
    throw new Error(`${file} needs entries, each with a reason`);
  }
  return parsed.entries;
}

export async function brandLeakHits(root, entries = []) {
  const hits = [];
  for (const file of await readTextFiles(root, ROOTS)) {
    const found = patternHits(file.text, PRODUCT);
    if (MASCOT_SURFACE.test(file.file)) found.push(...patternHits(file.text, MASCOT));
    for (const hit of found) {
      const row = { file: file.file, ...hit };
      if (!allowMatches(row, entries)) hits.push(row);
    }
  }
  return hits;
}

function parseArgs(argv) {
  let root = repoRoot;
  let allow = path.join(repoRoot, "brand", "allowed-brand.json");
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--root") root = path.resolve(argv[++index] ?? ".");
    else if (argv[index] === "--allow") allow = path.resolve(argv[++index] ?? ".");
    else {
      console.error(`unknown argument ${argv[index]}`);
      process.exit(1);
    }
  }
  return { root, allow };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { root, allow } = parseArgs(process.argv.slice(2));
  const hits = await brandLeakHits(root, loadAllowList(allow));
  if (hits.length === 0) {
    console.log("no brand leaks outside the allow-list");
    process.exit(0);
  }
  for (const hit of hits) console.error(`${formatHit(hit)} ${hit.value}`);
  process.exit(1);
}
