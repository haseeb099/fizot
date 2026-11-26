#!/usr/bin/env node
/**
 * Fly staging cleanup (Gate G0b).
 *
 * Modes (FLY_STAGING_CLEANUP_MODE):
 * - age (default): destroy fizot-cm-* older than FLY_STAGING_MAX_AGE_MS (default 24h).
 *   Refuses MAX_AGE_MS=0 — that used to wipe every fizot-cm-* in the org.
 * - run-scoped: destroy only apps listed in the run manifest for this workflow run.
 *   Never expands to all fizot-cm-*. Missing manifest with no apps → no-op success.
 *
 * Never logs the Fly token.
 */
import {
  createFlyMachinesClient,
  FLY_STAGING_APP_PREFIX,
  DEFAULT_FLY_ORG,
  resolveFlyOrg,
  formatCostProjection,
  projectDailyCost,
} from "../../server/fizot/admin/index.ts";
import {
  assertAgeCleanupSafe,
  readRunManifestFile,
  resolveCleanupMode,
  resolveRunManifestPath,
  selectRunScopedDestroyTargets,
  StagingSafetyError,
} from "../../server/fizot/admin/staging-safety.ts";

const token = process.env.FLY_API_TOKEN?.trim() ?? "";
const org = resolveFlyOrg();
const maxAgeMs = Number(process.env.FLY_STAGING_MAX_AGE_MS ?? String(24 * 60 * 60 * 1000));
const root = process.cwd();

let mode;
try {
  mode = resolveCleanupMode(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (!token) {
  console.error("FLY_API_TOKEN is required");
  process.exit(2);
}
if (!org) {
  console.error(`FLY_ORG is required (default ${DEFAULT_FLY_ORG})`);
  process.exit(2);
}

try {
  assertAgeCleanupSafe({
    mode,
    maxAgeMs,
    allowAgeZero: process.env.FLY_STAGING_ALLOW_AGE_ZERO === "1",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

console.log(formatCostProjection(projectDailyCost({})));
console.log(JSON.stringify({ flyOrg: org, defaultFlyOrg: DEFAULT_FLY_ORG, cleanupMode: mode }));
const fly = createFlyMachinesClient({ token, org, printCost: false });

let apps;
try {
  apps = await fly.listApps(org);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

const stagingNames = apps.filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX)).map((a) => a.name);
console.log(JSON.stringify({
  found: stagingNames,
  foundCount: stagingNames.length,
  org,
  cleanupMode: mode,
}));

const destroyed = [];
const errors = [];

if (mode === "run-scoped") {
  const manifestPath = resolveRunManifestPath(process.env, root);
  let manifest;
  try {
    manifest = readRunManifestFile(manifestPath);
  } catch (error) {
    if (error instanceof StagingSafetyError && /missing/.test(error.message)) {
      console.log(JSON.stringify({
        runScoped: true,
        manifestPath,
        note: "no run manifest; nothing to destroy (orphans rely on age cleanup)",
        destroyed: [],
        remainingCount: stagingNames.length,
      }));
      process.exit(0);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let selected;
  try {
    selected = selectRunScopedDestroyTargets({
      manifest,
      expectedOrg: org,
      existingAppNames: apps.map((a) => a.name),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(JSON.stringify({
    runScoped: true,
    manifestPath,
    destroy: selected.destroy,
    skippedMissing: selected.skippedMissing,
    refused: selected.refused,
  }));

  if (selected.refused.length > 0) {
    console.error(`refused invalid manifest app names: ${selected.refused.join(", ")}`);
    process.exit(1);
  }

  for (const name of selected.destroy) {
    try {
      console.log(JSON.stringify({ destroy: name, mode: "run-scoped" }));
      await fly.destroyApp(name);
      destroyed.push(name);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const remainingTracked = selected.destroy.filter((name) => !destroyed.includes(name));
  console.log(JSON.stringify({
    destroyed,
    count: destroyed.length,
    remainingTracked,
    remainingTrackedCount: remainingTracked.length,
    errors,
  }));
  if (errors.length > 0 || remainingTracked.length > 0) {
    console.error(`run-scoped cleanup failed: ${errors.join("; ") || remainingTracked.join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

// ——— age / orphan mode ———
const now = Date.now();
for (const app of apps) {
  if (!app.name.startsWith(FLY_STAGING_APP_PREFIX)) continue;
  const machines = await fly.listMachines(app.name);
  const oldest = machines
    .map((m) => (m.createdAt ? Date.parse(m.createdAt) : 0))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const ageMs = oldest ? now - oldest : maxAgeMs + 1;
  if (ageMs < maxAgeMs) {
    console.log(JSON.stringify({ keep: app.name, ageHours: Math.round(ageMs / 3_600_000 * 10) / 10 }));
    continue;
  }
  console.log(JSON.stringify({ destroy: app.name, ageHours: Math.round(ageMs / 3_600_000 * 10) / 10 }));
  try {
    await fly.destroyApp(app.name);
    destroyed.push(app.name);
  } catch (error) {
    errors.push(`${app.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const remaining = (await fly.listApps(org))
  .filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX))
  .map((a) => a.name);

console.log(JSON.stringify({
  destroyed,
  count: destroyed.length,
  remaining,
  remainingCount: remaining.length,
  errors,
}));

if (errors.length > 0) {
  console.error(`age cleanup errors: ${errors.join("; ")}`);
  process.exit(1);
}
