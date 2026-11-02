import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The ci.yml jobs a pull request runs only when its change can affect them;
// `static` and the `CI` gate always run. Besides these job ids a scope's checks
// name "build" (static's typecheck, Electron syntax check and UI build) and the
// vitest job's parts: "linux-tests", "host-tests" (Windows, and macOS where the
// event runs it), and the subsets in VITEST_SUBSETS.
export const SELECTABLE_JOBS = [
  "vitest", "behavior-evals", "packaged-server", "windows-cua", "electron-smokes", "cloudflared-linux-arm64",
  "foss", "control-plane", "ui-smoke", "browser-identity", "package-linux", "browser-driver", "docker",
];

// The server imports Electron and renderer modules, and the macOS smokes run
// the packaged server inside Electron, so a server change and a desktop change
// can affect the same checks.
const SERVER_CHECKS = [
  "build", "linux-tests", "host-tests", "behavior-evals", "packaged-server", "foss", "electron-smokes",
  "ui-smoke", "browser-identity", "browser-driver", "package-linux",
];
const EVERY_CHECK = [...SERVER_CHECKS, "windows-cua", "cloudflared-linux-arm64", "control-plane", "docker"];

/** What a pull request's change in each area can affect. */
export const AREA_CHECKS = {
  docs: ["docs-tests"],
  locales: ["build", "locale-tests"],
  web: ["build", "linux-tests", "ui-smoke"],
  "script-tests": ["linux-tests", "host-tests", "ui-smoke", "browser-identity"],
  server: SERVER_CHECKS,
  desktop: SERVER_CHECKS,
  "control-plane": ["control-plane"],
  everything: EVERY_CHECK,
};

/** The vitest files a pull request runs on Linux when it runs no full Linux
 * shards, as vitest filters. Locale tests: every test that reads a translation
 * other than English (the renderer's files take about nine minutes in one
 * process), with the Electron node tests, which compare their own copy of some
 * strings with every catalog. Docs tests: every test that reads the docs. */
export const VITEST_SUBSETS = {
  "locale-tests": { part: "locale tests", files: ["src/", "scripts/generate-locale.test.mjs", "scripts/testing/key-readback.e2e.test.ts"], shards: 2, nodeTests: true },
  "docs-tests": {
    part: "docs tests",
    files: ["scripts/testing/analytics-docs.test.ts"],
    shards: 1,
    nodeTests: false,
  },
};

/** Renderer files that also run outside the renderer: the server imports
 * them, or the macOS app-frame smoke bundles them. ci-scope.test.ts holds this
 * equal to the import graph. */
export const SRC_OUTSIDE_RENDERER = [
  "src/components/app/app-frame-host.ts",
  "src/lib/citations.ts",
  "src/lib/composer-attachments.ts",
];

export const DOCS = /^(?:[^/]+\.md|docs\/.+\.md|\.github\/FUNDING\.yml)$/;

// The first matching rule names a path's area; a path no rule names can affect
// anything. English is the source every test reads, so en.json is web.
const AREAS = [
  [DOCS, "docs"],
  [/^(?:apps\/)?docs\//, "docs"],
  [/^scripts\/.+\.test\.[cm]?[jt]sx?$/, "script-tests"],
  [/^src\/locales\/(?:(?!en\.json$)[^/]+\.json|[^/]+\.test\.ts)$/, "locales"],
  [/^(?:src|public)\/|^[^/]+-preview\.html$/, "web"],
  [/^(?:server|shared|enterprise|companion|evals|skills|deploy|cloudflare\/composio-broker)\/|^(?:Dockerfile|\.dockerignore|compose\.yaml)$/, "server"],
  [/^(?:electron|build)\/|^(?:electron-builder\.yml|index\.html)$/, "desktop"],
  [/^cloudflare\/control-plane\//, "control-plane"],
];

export function areaOf(file) {
  if (typeof file !== "string" || /\p{Cc}/u.test(file) || file.split("/").some((part) => !part || part === "." || part === "..")) {
    return "everything";
  }
  if (SRC_OUTSIDE_RENDERER.includes(file)) return "server";
  return AREAS.find(([pattern]) => pattern.test(file))?.[1] ?? "everything";
}

export const FULL_SCOPE = { areas: ["everything"], checks: [...EVERY_CHECK].sort() };

/** A pull request, a push to main and a merge group. The other jobs run only on the nightly schedule or a manual run. */
export const MAIN_SCOPE = {
  areas: ["daily"],
  checks: ["build", "docker", "foss", "packaged-server", "ui-smoke"],
};

/** A push whose commit already passed the CI gate in the merge queue: only the control-plane checks the broker deploy needs. */
export const QUEUED_SCOPE = { areas: ["tested in the merge queue"], checks: ["control-plane"] };

/** A pull request's areas and the checks they select, from its changed files. */
export function selectCiScope(files) {
  const areas = Array.isArray(files) && files.length > 0 ? [...new Set(files.map(areaOf))].sort() : ["everything"];
  if (areas.includes("everything")) return FULL_SCOPE;
  return { areas, checks: [...new Set(areas.flatMap((area) => AREA_CHECKS[area]))].sort() };
}

/** True when two package.json texts differ only in the top-level "version"
 * (the release bump, prepare-release.yml). Anything else that changed, a
 * reordered key included, or text that is not a JSON object, is false. */
export function versionOnlyPackageJson(before, after) {
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(a) || !isObject(b)) return false;
  if (typeof a.version !== "string" || typeof b.version !== "string" || a.version === b.version) return false;
  const { version: _before, ...restBefore } = a;
  const { version: _after, ...restAfter } = b;
  return JSON.stringify(restBefore) === JSON.stringify(restAfter);
}

/** A push's own diff (before..after) needs no runtime jobs when it is docs
 * only or only bumps package.json's version. `show(rev, path)` reads a file. */
export function selectPushScope(files, show) {
  if (!Array.isArray(files) || files.length === 0) return { runtime: true };
  if (files.every((file) => areaOf(file) === "docs" && DOCS.test(file))) return { runtime: false };
  if (files.length === 1 && files[0] === "package.json") {
    try {
      if (versionOnlyPackageJson(show("before", "package.json"), show("after", "package.json"))) return { runtime: false };
    } catch { /* unreadable: run everything */ }
  }
  return { runtime: true };
}

// The daily gate does not run the suite. The nightly and manual lane runs every platform.
export const ALL_OS = ["macos-latest", "ubuntu-latest", "windows-latest"];

/** Events whose runs test every platform: the nightly run, manual runs and the release lane (a manual run). */
export const FULL_LANE_EVENTS = ["schedule", "workflow_dispatch"];

/** Which lane an event's run is: a pull request's own areas, main's, or every check on every platform. */
export function laneOf(event) {
  if (event === "pull_request") return "pr";
  if (event === "push" || event === "merge_group") return "main";
  return "full";
}

// A shard runs its files one at a time, so the slowest shard sets the run's length. Windows and macOS run only the e2e
// files that depend on their OS, so their shards stay as short as Linux's, and macOS keeps four: the account runs five
// macOS jobs at a time.
export const VITEST_SHARDS = { "macos-latest": 4, "ubuntu-latest": 8, "windows-latest": 8 };

/** ci.yml's vitest matrix: every shard of every selected platform, and which e2e files that platform runs. */
export function vitestMatrix(oses) {
  return {
    include: oses.flatMap((os) => Array.from({ length: VITEST_SHARDS[os] }, (_, i) => ({
      os, part: `shard ${i + 1}/${VITEST_SHARDS[os]}`, shard: i + 1, shards: VITEST_SHARDS[os], files: "",
      e2e: os === "ubuntu-latest" ? "all" : "host", node_tests: i === 0,
    }))),
  };
}

/** What ci.yml runs for a scope on an event whose suite covers `oses`: the
 * selected job ids, whether `static` builds, and the vitest matrix. */
export function ciOutputs({ checks }, oses) {
  const platforms = oses.filter((os) => checks.includes(os === "ubuntu-latest" ? "linux-tests" : "host-tests"));
  const { include } = vitestMatrix(platforms);
  for (const [check, { part, files, shards, nodeTests }] of Object.entries(VITEST_SUBSETS)) {
    if (platforms.includes("ubuntu-latest") || !checks.includes(check)) continue;
    for (let shard = 1; shard <= shards; shard++) {
      include.push({
        os: "ubuntu-latest", part: shards > 1 ? `${part} ${shard}/${shards}` : part, shard, shards,
        files: files.join(" "), e2e: "all", node_tests: nodeTests && shard === 1,
      });
    }
  }
  const jobs = SELECTABLE_JOBS.filter((job) => (job === "vitest" ? include.length > 0 : checks.includes(job)));
  return {
    build: checks.includes("build"),
    jobs,
    vitest_os: oses,
    // macOS's packaged server smoke runs in the macOS smokes job.
    packaged_server_os: oses.filter((os) => os !== "macos-latest"),
    // GitHub refuses an empty matrix, so a vitest job its `if` skips keeps the full one.
    vitest_matrix: include.length > 0 ? { include } : vitestMatrix(oses),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lane = laneOf(process.env.GITHUB_EVENT_NAME);
  const scope = lane === "full" ? FULL_SCOPE : MAIN_SCOPE;
  const vitestOs = lane === "full" ? ALL_OS : ["ubuntu-latest"];
  const outputs = ciOutputs(scope, vitestOs);
  console.log(`CI scope: ${scope.areas.join(", ")} -> ${outputs.jobs.join(", ") || "static checks only"}`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${typeof value === "boolean" ? value : JSON.stringify(value)}\n`).join(""),
  );
}
