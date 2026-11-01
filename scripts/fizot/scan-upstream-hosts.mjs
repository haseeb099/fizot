import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowMatches, formatHit, patternHits, readTextFiles } from "./scan-text.mjs";

// Shipped source plus built output. dist/ and dist-server/ are absent until a build.
const ROOTS = ["server", "src", "shared", "electron", "companion", "public", "scripts", "dist", "dist-server", "package.json", "index.html", "LICENSE", "NOTICE", "LICENSING.md", "CLA.md"];

// Upstream product domains, the staging broker host, and the upstream update repository.
const HOST = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:openmausbot\.com|mausbot\.com|supamaus\.[a-z]{2,}|boat\.dev|posthog\.com)(?![a-z0-9-])|(?:https?:\/\/)?omb-cloud[a-z0-9-]*\.fly\.dev(?![a-z0-9-])|github\.com\/milind-soni\/OpenMausBot(?![a-z0-9-])/gi;

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function loadAllowList(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry.reason !== "string" || entry.reason.length === 0)) {
    throw new Error(`${file} needs entries, each with a reason`);
  }
  return parsed.entries;
}

export function matchesUpstreamHost(value) {
  HOST.lastIndex = 0;
  return HOST.test(value);
}

export async function upstreamHostHits(root, entries = []) {
  const hits = [];
  for (const file of await readTextFiles(root, ROOTS)) {
    for (const hit of patternHits(file.text, HOST)) {
      const row = { file: file.file, ...hit };
      if (!allowMatches(row, entries)) hits.push(row);
    }
  }
  return hits;
}

function parseArgs(argv) {
  let root = repoRoot;
  let allow = path.join(repoRoot, "brand", "allowed-hosts.json");
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
  const hits = await upstreamHostHits(root, loadAllowList(allow));
  if (hits.length === 0) {
    console.log("no upstream hosts outside the allow-list");
    process.exit(0);
  }
  for (const hit of hits) console.error(`${formatHit(hit)} ${hit.value}`);
  process.exit(1);
}
