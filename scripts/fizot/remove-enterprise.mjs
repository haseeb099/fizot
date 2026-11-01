import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


// enterprise/ is source-available. This deletes that tree and the other named trees without reading their files.
const PROTECTED = new Set(["LICENSE", "NOTICE", "LICENSING.md", "CLA.md"]);
const TREES = ["enterprise", "cloudflare/control-plane", "apps/docs", ".tmpexp"];
const WORKSPACE_LINES = new Set([
  '  - "apps/docs"',
  '  - "cloudflare/control-plane"',
]);

function argumentRefused(token) {
  return PROTECTED.has(token) || PROTECTED.has(path.basename(token));
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--root") {
      const value = argv[++i];
      if (value === undefined || argumentRefused(value)) {
        console.error(`refusing to touch ${value ?? "--root"}`);
        process.exit(1);
      }
      root = path.resolve(value);
      continue;
    }
    if (argumentRefused(token)) {
      console.error(`refusing to touch ${token}`);
      process.exit(1);
    }
    console.error(`unknown argument ${token}`);
    process.exit(1);
  }
  return root;
}

export async function removeEnterpriseTrees(root) {
  const removed = [];
  for (const relative of TREES) {
    const target = path.join(root, ...relative.split("/"));
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(relative + "/");
  }
  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  if (existsSync(workspacePath)) {
    const original = await readFile(workspacePath, "utf8");
    const lines = original.split(/\r?\n/);
    const kept = lines.filter((line) => !WORKSPACE_LINES.has(line));
    if (kept.length !== lines.length) {
      const newline = original.endsWith("\n") ? "\n" : "";
      const next = kept.join("\n").replace(/\n+$/, "") + newline;
      if (next !== original) await writeFile(workspacePath, next);
      for (const line of lines) {
        if (WORKSPACE_LINES.has(line)) removed.push(`pnpm-workspace.yaml ${line.trim()}`);
      }
    }
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = parseArgs(process.argv.slice(2));
  const removed = await removeEnterpriseTrees(root);
  if (removed.length === 0) console.log("nothing to remove");
  else for (const line of removed) console.log(`removed ${line}`);
}
