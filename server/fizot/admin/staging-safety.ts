/**
 * Fly staging safety: run manifests, preflight, run-scoped cleanup selection.
 * Never destroys apps outside an explicit allow-list from the current run.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { FLY_STAGING_APP_PREFIX, DEFAULT_FLY_ORG } from "./fly.ts";

export const FLY_STAGING_IMAGE_APP = "fizot-home-image";
export const STAGING_RUN_MANIFEST_SCHEMA = 1 as const;
export const DEFAULT_STAGING_RUN_MANIFEST_REL = path.join(
  "artifacts",
  "fly-staging",
  "run-manifest.json",
);

export type StagingCleanupMode = "run-scoped" | "age";

export type StagingRunManifest = {
  schemaVersion: typeof STAGING_RUN_MANIFEST_SCHEMA;
  flyOrg: string;
  workflowRunId: string | null;
  mode: string;
  createdAt: string;
  updatedAt: string;
  imageApp: string;
  /** Disposable Cloud-home apps created by this run (`fizot-cm-*` only). */
  appNames: string[];
};

export class StagingSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingSafetyError";
  }
}

const PRODUCTION_NAME_HINT =
  /(^|-)(prod|production|customer|live|billing-prod)(-|$)/i;

/** True when the name is a disposable staging Cloud-home app. */
export function isStagingCloudHomeApp(
  appName: string,
  prefix = FLY_STAGING_APP_PREFIX,
): boolean {
  return typeof appName === "string" && appName.startsWith(prefix) && appName.length > prefix.length;
}

/** Refuse names that are not disposable staging apps (or empty). */
export function assertDisposableStagingAppName(
  appName: string,
  prefix = FLY_STAGING_APP_PREFIX,
): void {
  if (!isStagingCloudHomeApp(appName, prefix)) {
    throw new StagingSafetyError(
      `refusing non-disposable app name ${JSON.stringify(appName)} (need prefix ${prefix})`,
    );
  }
  if (PRODUCTION_NAME_HINT.test(appName)) {
    throw new StagingSafetyError(
      `refusing app name with production indicator: ${appName}`,
    );
  }
}

export function createEmptyRunManifest(input: {
  flyOrg: string;
  mode: string;
  workflowRunId?: string | null;
  imageApp?: string;
  now?: () => string;
}): StagingRunManifest {
  const org = input.flyOrg.trim();
  if (!org) throw new StagingSafetyError("run manifest requires flyOrg");
  const now = (input.now ?? (() => new Date().toISOString()))();
  return {
    schemaVersion: STAGING_RUN_MANIFEST_SCHEMA,
    flyOrg: org,
    workflowRunId: input.workflowRunId ?? null,
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
    imageApp: input.imageApp ?? FLY_STAGING_IMAGE_APP,
    appNames: [],
  };
}

export function recordCreatedApp(
  manifest: StagingRunManifest,
  appName: string,
  options: { now?: () => string; prefix?: string } = {},
): StagingRunManifest {
  assertDisposableStagingAppName(appName, options.prefix);
  if (manifest.appNames.includes(appName)) return manifest;
  const now = (options.now ?? (() => new Date().toISOString()))();
  return {
    ...manifest,
    updatedAt: now,
    appNames: [...manifest.appNames, appName],
  };
}

export function parseRunManifest(raw: unknown): StagingRunManifest {
  if (!raw || typeof raw !== "object") {
    throw new StagingSafetyError("run manifest must be an object");
  }
  const row = raw as Record<string, unknown>;
  if (row.schemaVersion !== STAGING_RUN_MANIFEST_SCHEMA) {
    throw new StagingSafetyError(`unsupported run manifest schemaVersion ${String(row.schemaVersion)}`);
  }
  const flyOrg = String(row.flyOrg ?? "").trim();
  if (!flyOrg) throw new StagingSafetyError("run manifest missing flyOrg");
  const imageApp = String(row.imageApp ?? FLY_STAGING_IMAGE_APP).trim() || FLY_STAGING_IMAGE_APP;
  const appNamesRaw = row.appNames;
  if (!Array.isArray(appNamesRaw)) {
    throw new StagingSafetyError("run manifest appNames must be an array");
  }
  const appNames: string[] = [];
  for (const name of appNamesRaw) {
    if (typeof name !== "string") {
      throw new StagingSafetyError("run manifest appNames must be strings");
    }
    assertDisposableStagingAppName(name);
    if (!appNames.includes(name)) appNames.push(name);
  }
  return {
    schemaVersion: STAGING_RUN_MANIFEST_SCHEMA,
    flyOrg,
    workflowRunId: row.workflowRunId == null ? null : String(row.workflowRunId),
    mode: String(row.mode ?? "unknown"),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
    imageApp,
    appNames,
  };
}

export function readRunManifestFile(filePath: string): StagingRunManifest {
  if (!existsSync(filePath)) {
    throw new StagingSafetyError(`run manifest missing: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new StagingSafetyError(
      `run manifest unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRunManifest(parsed);
}

export function writeRunManifestFile(filePath: string, manifest: StagingRunManifest): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Select apps this run may destroy. Validates org match and disposable names.
 * Never expands to "all fizot-cm-*".
 */
export function selectRunScopedDestroyTargets(input: {
  manifest: StagingRunManifest;
  expectedOrg: string;
  existingAppNames: ReadonlyArray<string>;
  prefix?: string;
}): { destroy: string[]; skippedMissing: string[]; refused: string[] } {
  const expectedOrg = input.expectedOrg.trim();
  if (!expectedOrg) {
    throw new StagingSafetyError("expectedOrg is required for run-scoped cleanup");
  }
  if (input.manifest.flyOrg !== expectedOrg) {
    throw new StagingSafetyError(
      `run manifest org ${input.manifest.flyOrg} does not match cleanup org ${expectedOrg}`,
    );
  }
  const existing = new Set(input.existingAppNames);
  const destroy: string[] = [];
  const skippedMissing: string[] = [];
  const refused: string[] = [];
  for (const name of input.manifest.appNames) {
    try {
      assertDisposableStagingAppName(name, input.prefix);
    } catch {
      refused.push(name);
      continue;
    }
    if (name === input.manifest.imageApp || name === FLY_STAGING_IMAGE_APP) {
      refused.push(name);
      continue;
    }
    if (!existing.has(name)) {
      skippedMissing.push(name);
      continue;
    }
    destroy.push(name);
  }
  return { destroy, skippedMissing, refused };
}

export type StagingPreflightResult =
  | { ok: true; appNames: string[]; imagePresent: boolean; cloudHomeCount: number }
  | { ok: false; reasons: string[]; appNames: string[] };

/**
 * Read-only org inventory check. Fail closed on unexpected or production-looking apps.
 */
export function evaluateStagingPreflight(input: {
  org: string;
  apps: ReadonlyArray<{ name: string }>;
  mode?: string;
  expectedImageApp?: string;
  /** When true (isolation), any pre-existing fizot-cm-* fails the preflight. */
  requireEmptyCloudHomes?: boolean;
  productionOrgs?: ReadonlyArray<string>;
}): StagingPreflightResult {
  const org = input.org.trim();
  const reasons: string[] = [];
  if (!org) reasons.push("missing Fly org");
  const blocked = new Set((input.productionOrgs ?? []).map((s) => s.toLowerCase()));
  if (org && blocked.has(org.toLowerCase())) {
    reasons.push(`org ${org} is listed as production`);
  }
  const imageApp = input.expectedImageApp ?? FLY_STAGING_IMAGE_APP;
  const requireEmpty =
    input.requireEmptyCloudHomes ??
    (input.mode ?? "").trim().toLowerCase() === "isolation";
  const appNames = input.apps.map((a) => a.name).filter(Boolean).sort();
  let cloudHomeCount = 0;
  let imagePresent = false;
  for (const name of appNames) {
    if (name === imageApp) {
      imagePresent = true;
      continue;
    }
    if (isStagingCloudHomeApp(name)) {
      cloudHomeCount += 1;
      if (requireEmpty) {
        reasons.push(`unexpected pre-existing staging app ${name} (isolation requires exclusive empty org)`);
      }
      continue;
    }
    if (PRODUCTION_NAME_HINT.test(name)) {
      reasons.push(`production-looking app ${name}`);
      continue;
    }
    reasons.push(`unexpected app ${name} (allowed: ${imageApp}, ${FLY_STAGING_APP_PREFIX}*)`);
  }
  if (reasons.length) return { ok: false, reasons, appNames };
  return { ok: true, appNames, imagePresent, cloudHomeCount };
}

/**
 * Age-based orphan cleanup must never use maxAgeMs=0 (that deleted every fizot-cm-*).
 * Run-scoped cleanup is the only path that may destroy by explicit manifest.
 */
export function assertAgeCleanupSafe(input: {
  mode: StagingCleanupMode;
  maxAgeMs: number;
  allowAgeZero?: boolean;
}): void {
  if (input.mode === "run-scoped") return;
  if (input.mode !== "age") {
    throw new StagingSafetyError(`unknown cleanup mode ${String(input.mode)}`);
  }
  if (input.maxAgeMs === 0 && !input.allowAgeZero) {
    throw new StagingSafetyError(
      "age cleanup refuses FLY_STAGING_MAX_AGE_MS=0; use FLY_STAGING_CLEANUP_MODE=run-scoped with a run manifest",
    );
  }
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {
    throw new StagingSafetyError(`invalid maxAgeMs ${input.maxAgeMs}`);
  }
}

export function resolveCleanupMode(env: NodeJS.ProcessEnv = process.env): StagingCleanupMode {
  const raw = (env.FLY_STAGING_CLEANUP_MODE ?? "age").trim().toLowerCase();
  if (raw === "run-scoped" || raw === "run_scoped" || raw === "manifest") return "run-scoped";
  if (raw === "age" || raw === "orphan" || raw === "24h") return "age";
  throw new StagingSafetyError(
    `FLY_STAGING_CLEANUP_MODE must be run-scoped or age (got ${raw})`,
  );
}

export function resolveRunManifestPath(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): string {
  const fromEnv = env.FLY_STAGING_RUN_MANIFEST?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(root, fromEnv);
  return path.join(root, DEFAULT_STAGING_RUN_MANIFEST_REL);
}

/** GitHub Actions concurrency group for a staging org (documentation + tests). */
export function stagingConcurrencyGroup(flyOrg: string): string {
  const org = flyOrg.trim() || DEFAULT_FLY_ORG;
  return `fizot-fly-staging-${org}`;
}

/**
 * Overall isolation acceptance: probes PASS and cleanup ok.
 * Failed or missing cleanup cannot be reported as acceptance success.
 */
export function isolationAcceptanceOk(input: {
  probeOverall: "PASS" | "FAIL" | "INCONCLUSIVE" | "NOT_RUN";
  cleanupOutcome: "ok" | "partial-failure" | "skipped" | "error" | string;
}): boolean {
  return input.probeOverall === "PASS" && input.cleanupOutcome === "ok";
}
