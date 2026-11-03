#!/usr/bin/env node
/**
 * S2.10: record Fly usage while a staging machine is awake and after sleep.
 * Caps machine observation at MAX_PROBE_MACHINE_SECONDS (1 hour).
 * Never logs FLY_API_TOKEN or bootstrap secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFlyMachinesClient,
  FLY_HOME_VOLUME_GB,
  MAX_PROBE_MACHINE_SECONDS,
  formatCostProjection,
  projectDailyCost,
} from "../../server/fizot/admin/public.ts";
import {
  FLY_SHARED_CPU_1X_USD_PER_SEC,
  FLY_VOLUME_USD_PER_GB_MONTH,
} from "../../server/fizot/admin/cost-guard.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT_DIR = path.join(ROOT, "artifacts", "s2-10");

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const phase = arg("phase", "awake");
const appName = arg("app");
const org = arg("org", process.env.FLY_ORG ?? "");
const token = process.env.FLY_API_TOKEN?.trim() ?? "";
const maxSeconds = Math.min(
  Number(arg("max-seconds", String(MAX_PROBE_MACHINE_SECONDS))) || MAX_PROBE_MACHINE_SECONDS,
  MAX_PROBE_MACHINE_SECONDS,
);
const sampleSeconds = Math.min(Number(arg("sample-seconds", "30")) || 30, maxSeconds);

if (!token) {
  console.error("fly-cost-probe: FLY_API_TOKEN is required");
  process.exit(2);
}
if (!org) {
  console.error("fly-cost-probe: FLY_ORG / --org is required");
  process.exit(2);
}
if (!appName) {
  console.error("fly-cost-probe: --app= is required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(formatCostProjection(projectDailyCost({ volumeGb: FLY_HOME_VOLUME_GB })));

const fly = createFlyMachinesClient({ token, org, printCost: false });
const startedAt = Date.now();
const machines = await fly.listMachines(appName);
const volumes = await fly.listVolumes(appName);
const machine = machines[0] ?? null;
const volumeGb = volumes.reduce((sum, v) => sum + (v.sizeGb || 0), 0) || FLY_HOME_VOLUME_GB;

let observedSeconds = 0;
let lastState = machine?.state ?? "missing";
const deadline = startedAt + sampleSeconds * 1000;

while (Date.now() < deadline) {
  const elapsed = (Date.now() - startedAt) / 1000;
  if (elapsed >= maxSeconds) {
    console.error(`fly-cost-probe: hit MAX_PROBE_MACHINE_SECONDS=${maxSeconds}; stopping`);
    break;
  }
  try {
    const live = await fly.listMachines(appName);
    lastState = live[0]?.state ?? "missing";
    if (["started", "created", "starting"].includes(lastState)) {
      observedSeconds = Math.min(maxSeconds, elapsed);
    }
  } catch {
    lastState = "error";
  }
  await sleep(5_000);
}

observedSeconds = Math.min(maxSeconds, Math.max(observedSeconds, (Date.now() - startedAt) / 1000));

/** Egress is not on the Machines list API; cost sheet fills measured egress later. */
const egressBytes = null;
const machineUsd = observedSeconds * FLY_SHARED_CPU_1X_USD_PER_SEC;
const volumeUsdForWindow = (FLY_VOLUME_USD_PER_GB_MONTH * volumeGb) / (30 * 86_400) * observedSeconds;

const record = {
  schema: "fizot-s2-10-fly-usage/v1",
  phase,
  recordedAt: new Date().toISOString(),
  appName,
  org,
  machineId: machine?.id ?? null,
  machineState: lastState,
  machineSeconds: Math.round(observedSeconds * 1000) / 1000,
  volumeGb,
  egressBytes,
  egressNote: "not exposed by Machines list API; leave null for the cost sheet",
  costUsd: {
    machine: Math.round(machineUsd * 1e6) / 1e6,
    volumeWindow: Math.round(volumeUsdForWindow * 1e6) / 1e6,
    rates: {
      sharedCpu1xUsdPerSec: FLY_SHARED_CPU_1X_USD_PER_SEC,
      volumeUsdPerGbMonth: FLY_VOLUME_USD_PER_GB_MONTH,
    },
  },
  caps: {
    maxProbeMachineSeconds: MAX_PROBE_MACHINE_SECONDS,
    sampleSeconds,
  },
};

const file = path.join(OUT_DIR, `${phase}-${appName}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`fly-cost-probe: wrote ${file}`);
console.log(JSON.stringify({
  phase,
  appName,
  machineSeconds: record.machineSeconds,
  volumeGb: record.volumeGb,
  machineUsd: record.costUsd.machine,
  egressBytes: record.egressBytes,
}, null, 2));
