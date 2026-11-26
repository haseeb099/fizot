#!/usr/bin/env node
/**
 * Read-only Fly staging preflight. Lists org apps and fail-closes on unexpected
 * or production-looking resources. Never creates, modifies, or deletes.
 * Never prints FLY_API_TOKEN.
 */
import {
  createFlyMachinesClient,
  DEFAULT_FLY_ORG,
  resolveFlyOrg,
  formatCostProjection,
  projectDailyCost,
} from "../../server/fizot/admin/index.ts";
import {
  evaluateStagingPreflight,
  FLY_STAGING_IMAGE_APP,
} from "../../server/fizot/admin/staging-safety.ts";

const token = process.env.FLY_API_TOKEN?.trim() ?? "";
const org = resolveFlyOrg();
const mode = (process.env.FIZOT_ROUNDTRIP_MODE ?? "home").trim().toLowerCase();
const imageApp = (process.env.FLY_IMAGE_APP ?? FLY_STAGING_IMAGE_APP).trim() || FLY_STAGING_IMAGE_APP;
const productionOrgs = (process.env.FIZOT_PRODUCTION_FLY_ORGS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!token) {
  console.error("FLY_API_TOKEN is required (value not printed)");
  process.exit(2);
}
if (!org) {
  console.error(`FLY_ORG is required (default ${DEFAULT_FLY_ORG})`);
  process.exit(2);
}

console.log(formatCostProjection(projectDailyCost({})));
console.log(JSON.stringify({
  step: "preflight_begin",
  flyOrg: org,
  mode,
  expectedImageApp: imageApp,
  tokenPresent: true,
}));

const fly = createFlyMachinesClient({ token, org, printCost: false });
let apps;
try {
  apps = await fly.listApps(org);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = evaluateStagingPreflight({
  org,
  apps,
  mode,
  expectedImageApp: imageApp,
  productionOrgs,
});

console.log(JSON.stringify({
  step: "preflight_inventory",
  flyOrg: org,
  appNames: result.appNames,
  appCount: result.appNames.length,
  ok: result.ok,
  ...(result.ok
    ? { imagePresent: result.imagePresent, cloudHomeCount: result.cloudHomeCount }
    : { reasons: result.reasons }),
}));

if (!result.ok) {
  console.error(`staging preflight failed:\n- ${result.reasons.join("\n- ")}`);
  process.exit(1);
}

console.log(JSON.stringify({ step: "preflight_ok", flyOrg: org, mode }));
