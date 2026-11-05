#!/usr/bin/env node
/**
 * Destroy staging apps older than 24 hours (Gate G0b cost guard).
 * Prefix: fizot-cm-. Never logs the Fly token.
 * When FLY_STAGING_MAX_AGE_MS=0 (roundtrip leftover sweep), remaining must be 0.
 */
import {
  createFlyMachinesClient,
  FLY_STAGING_APP_PREFIX,
  DEFAULT_FLY_ORG,
  resolveFlyOrg,
  formatCostProjection,
  projectDailyCost,
} from "../../server/fizot/admin/index.ts";

const token = process.env.FLY_API_TOKEN?.trim() ?? "";
const org = resolveFlyOrg();
const maxAgeMs = Number(process.env.FLY_STAGING_MAX_AGE_MS ?? String(24 * 60 * 60 * 1000));

if (!token) {
  console.error("FLY_API_TOKEN is required");
  process.exit(2);
}
if (!org) {
  console.error(`FLY_ORG is required (default ${DEFAULT_FLY_ORG})`);
  process.exit(2);
}

console.log(formatCostProjection(projectDailyCost({})));
console.log(JSON.stringify({ flyOrg: org, defaultFlyOrg: DEFAULT_FLY_ORG }));
const fly = createFlyMachinesClient({ token, org, printCost: false });

let apps;
try {
  apps = await fly.listApps(org);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

console.log(JSON.stringify({
  found: apps.filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX)).map((a) => a.name),
  foundCount: apps.filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX)).length,
  org,
}));

const now = Date.now();
const destroyed = [];

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
  await fly.destroyApp(app.name);
  destroyed.push(app.name);
}

const remaining = (await fly.listApps(org))
  .filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX))
  .map((a) => a.name);

console.log(JSON.stringify({
  destroyed,
  count: destroyed.length,
  remaining,
  remainingCount: remaining.length,
}));

if (maxAgeMs === 0 && remaining.length > 0) {
  console.error(`cleanup left ${remaining.length} staging app(s): ${remaining.join(", ")}`);
  process.exit(1);
}
