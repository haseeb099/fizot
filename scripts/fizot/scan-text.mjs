import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// enterprise/ is never opened. A directory with that name is skipped by name.
const SKIP_DIRS = new Set(["node_modules", ".git", "enterprise", "coverage", "release", ".pnpm"]);
const TEXT = /\.(?:[cm]?[jt]sx?|mjs|cjs|json|html|md|css|svg|yml|yaml|txt|xml|plist|nsh|desktop|toml)$/i;
const EXTENSIONLESS = new Set(["LICENSE", "NOTICE"]);

export async function readTextFiles(root, relativePaths) {
  const files = [];
  for (const relative of relativePaths) await walk(path.join(root, relative), root, files);
  return files;
}

async function walk(dir, root, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      if (error.code === "ENOTDIR") await pushFile(dir, root, files);
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, files);
    else if (entry.isFile()) await pushFile(full, root, files);
  }
}

async function pushFile(full, root, files) {
  if (!TEXT.test(full) && !EXTENSIONLESS.has(path.basename(full))) return;
  const source = await readFile(full);
  if (source.includes(0)) return;
  files.push({
    file: path.relative(root, full).split(path.sep).join("/"),
    text: source.toString("utf8"),
  });
}

export function patternHits(text, pattern) {
  const hits = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    pattern.lastIndex = 0;
    for (const value of lines[index].match(pattern) ?? []) {
      hits.push({ line: index + 1, value, lineText: lines[index] });
    }
  }
  return hits;
}

export function allowMatches(hit, entries) {
  return entries.some((entry) => {
    if (entry.host && hostKey(hit.value) === entry.host.toLowerCase()) return true;
    if (entry.path) {
      const prefix = entry.path.replace(/\\/g, "/").replace(/\/$/, "");
      if (hit.file === prefix || hit.file.startsWith(`${prefix}/`)) return true;
    }
    if (entry.lineIncludes && hit.lineText.includes(entry.lineIncludes)) return true;
    return false;
  });
}

export function hostKey(value) {
  const bare = value.replace(/^https?:\/\//i, "").replace(/:\d+(?=\/|$)/, "").replace(/\.$/, "").toLowerCase();
  if (bare.startsWith("github.com/milind-soni/openmausbot")) return "github.com/milind-soni/openmausbot";
  return bare.split("/")[0];
}

export function formatHit(hit) {
  return `${hit.file}:${hit.line}`;
}
