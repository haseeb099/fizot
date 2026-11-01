import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import specifiers only. A comment or a config string that names enterprise/ is not an import.
// server/enterprise.ts is the loader; it may import the layer. Do not open files inside enterprise/.
const LOADER = path.normalize("server/enterprise.ts");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", "build", "coverage", "enterprise"]);
const SPECIFIER = /(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function parseRoot(argv) {
  let root = repoRoot;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i] ?? ".");
    else {
      console.error(`unknown argument ${argv[i]}`);
      process.exit(1);
    }
  }
  return root;
}

function specifierHits(source) {
  const hits = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? "";
    if (specifier.includes("enterprise/")) hits.push(specifier);
  }
  return hits;
}

async function walk(dir, root, hits) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, hits);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(?:[cm]?[jt]s|[jt]sx|mjs|cjs)$/.test(entry.name)) continue;
    const relative = path.normalize(path.relative(root, full));
    if (relative === LOADER) continue;
    const source = await readFile(full, "utf8");
    for (const specifier of specifierHits(source)) hits.push(`${relative}: ${specifier}`);
  }
}

export async function enterpriseImportHits(root) {
  const hits = [];
  await walk(root, root, hits);
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = await enterpriseImportHits(parseRoot(process.argv.slice(2)));
  if (hits.length === 0) {
    console.log("no enterprise imports");
    process.exit(0);
  }
  for (const hit of hits) console.error(hit);
  process.exit(1);
}
