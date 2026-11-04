#!/usr/bin/env node
/**
 * S2.11 Fly staging round trip: create → health → pairing → power →
 * negative signature/replay → destroy. Uses FLY_API_TOKEN from the environment only.
 * Never prints the token or bootstrap secret.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createAdminServer,
  createFlyMachinesClient,
  adminRequestSignature,
  mintNonce,
  formatCostProjection,
  projectDailyCost,
  FLY_STAGING_APP_PREFIX,
  MAX_PROBE_MACHINE_SECONDS,
  describeFetchError,
} from "../../server/fizot/admin/index.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACTS = path.join(ROOT, "artifacts", "fly-staging");
mkdirSync(ARTIFACTS, { recursive: true });

const HEALTH_DEADLINE_MS = 8 * 60_000;
const EARLY_FAIL_MS = 3 * 60_000;
const MACHINE_LOG_EVERY_MS = 60_000;

function log(step, detail = {}) {
  const line = { step, at: new Date().toISOString(), ...detail };
  console.log(JSON.stringify(line));
  return line;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const token = process.env.FLY_API_TOKEN?.trim() ?? "";
const org = process.env.FLY_ORG?.trim() ?? "";
const region = process.env.FLY_REGION?.trim() ?? "lhr";
const image = process.env.FIZOT_MACHINE_IMAGE?.trim() ?? "";

if (!token) {
  console.error("FLY_API_TOKEN is required (GitHub Actions secret / env). Refusing to run.");
  process.exit(2);
}
if (!org) {
  console.error("FLY_ORG is required.");
  process.exit(2);
}
if (!image) {
  console.error("FIZOT_MACHINE_IMAGE is required (Fly registry tag for the cloud-home image).");
  process.exit(2);
}

console.log(formatCostProjection(projectDailyCost({})));
log("cost_projection_printed");

const fly = createFlyMachinesClient({ token, org });
const admin = await createAdminServer({
  adminUrl: process.env.FIZOT_ADMIN_URL ?? "https://admin.fizot.staging.invalid",
  flyOrg: org,
  flyRegion: region,
  machineImage: image,
  fly,
  cookieSecure: false,
});

let workspaceId = "";
let appName = "";
let flyMachineId = "";
let sessionCookie = "";
const report = { steps: [], ok: false, negatives: {}, flyCost: null };

function cookieHeader() {
  if (!sessionCookie) throw new Error("session cookie missing; sign-in first");
  return { cookie: sessionCookie };
}

function takeSessionCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const hit = raw.find((c) => c.startsWith("fizot_admin_session="));
  if (!hit) throw new Error("fake-sign-in did not Set-Cookie fizot_admin_session");
  return hit.split(";")[0];
}

async function logMachineState(reason) {
  if (!appName) return null;
  try {
    const machines = await fly.listMachines(appName);
    const machine = flyMachineId
      ? (await fly.getMachine(appName, flyMachineId).catch(() => machines[0] ?? null))
      : (machines[0] ?? null);
    const detail = {
      reason,
      state: machine?.state ?? "missing",
      machineId: machine?.id ?? null,
      checks: machine?.checks ?? null,
      events: machine?.events ?? [],
      machineCount: machines.length,
    };
    report.steps.push(log("machine_state", detail));
    return machine;
  } catch (error) {
    report.steps.push(log("machine_state_error", {
      reason,
      message: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

try {
  log("sign_in_begin");
  const signedIn = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "staging-roundtrip@fizot.test" }),
  });
  const signedBody = await signedIn.json().catch(() => ({}));
  if (!signedIn.ok) throw new Error(`sign-in failed: ${signedIn.status} ${JSON.stringify(signedBody)}`);
  sessionCookie = takeSessionCookie(signedIn);
  report.steps.push(log("sign_in", { status: signedIn.status, accountId: signedBody.accountId ?? null }));

  log("create_workspace_begin");
  const created = await fetch(`${admin.url}/admin/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader() },
    body: JSON.stringify({ plan: "home", ownerEmail: "staging-roundtrip@fizot.test" }),
  });
  const createdBody = await created.json();
  if (!created.ok) throw new Error(`create failed: ${created.status} ${JSON.stringify(createdBody)}`);
  workspaceId = createdBody.workspace.id;
  appName = createdBody.workspace.appName;
  flyMachineId = createdBody.workspace.flyMachineId ?? "";
  report.steps.push(log("create", { status: created.status, workspaceId, appName, flyMachineId }));

  const stored = await admin.services.store.get(workspaceId);
  if (!stored) throw new Error("workspace missing from store after create");
  flyMachineId = stored.flyMachineId || flyMachineId;
  const publicUrl = stored.publicUrl;
  const secret = stored.bootstrapSecret;

  await logMachineState("after_create");

  const healthStarted = Date.now();
  const healthDeadline = healthStarted + HEALTH_DEADLINE_MS;
  let healthOk = false;
  let lastMachineLogAt = 0;
  while (Date.now() < healthDeadline) {
    const elapsed = Date.now() - healthStarted;
    if (elapsed >= EARLY_FAIL_MS) {
      const machine = await logMachineState("early_fail_check");
      if (!machine || machine.state !== "started") {
        throw new Error(
          `machine not started after ${Math.round(elapsed / 1000)}s (state=${machine?.state ?? "missing"}); failing early`,
        );
      }
    }
    if (Date.now() - lastMachineLogAt >= MACHINE_LOG_EVERY_MS) {
      await logMachineState("health_wait");
      lastMachineLogAt = Date.now();
    }

    let health;
    let body = {};
    try {
      health = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/health`, {
        headers: cookieHeader(),
      });
      body = await health.json().catch(() => ({}));
    } catch (error) {
      log("health_wait", { status: 0, error: describeFetchError(error) });
      await sleep(10_000);
      continue;
    }
    if (health.status === 200 && (body.ok === true || body.v === 1)) {
      report.steps.push(log("health", { status: health.status, bodyKeys: Object.keys(body) }));
      healthOk = true;
      break;
    }
    log("health_wait", { status: health.status, error: body.error ?? null });
    await sleep(10_000);
  }
  if (!healthOk) throw new Error("machine health did not become ready within 8 minutes");

  const pairing = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader() },
    body: JSON.stringify({ label: "staging-roundtrip", ttlSeconds: 120 }),
  });
  const pairingBody = await pairing.json().catch(() => ({}));
  if (pairing.status !== 200) throw new Error(`pairing failed: ${pairing.status}`);
  if (typeof pairingBody.pairingLink !== "string" || !pairingBody.pairingLink.includes("/pair#signin=")) {
    throw new Error("pairing response missing pairingLink");
  }
  report.steps.push(log("pairing", { status: pairing.status, hasLink: true }));

  const power = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/power`, {
    headers: cookieHeader(),
  });
  const powerBody = await power.json().catch(() => ({}));
  if (power.status !== 200) throw new Error(`power failed: ${power.status}`);
  report.steps.push(log("power", { status: power.status, state: powerBody.state ?? powerBody }));

  const probeAwake = spawnSync(
    process.execPath,
    ["--experimental-strip-types", path.join(ROOT, "scripts/fizot/fly-cost-probe.mjs"),
      `--app=${appName}`, `--org=${org}`, "--phase=awake", "--sample-seconds=25",
      "--expect-state=started",
      `--max-seconds=${Math.min(120, MAX_PROBE_MACHINE_SECONDS)}`],
    { env: process.env, encoding: "utf8" },
  );
  if (probeAwake.status !== 0) {
    console.error(probeAwake.stderr || probeAwake.stdout);
    throw new Error(`awake cost probe failed (${probeAwake.status})`);
  }
  console.log(probeAwake.stdout);
  report.steps.push(log("cost_probe_awake", { exit: probeAwake.status }));

  {
    const target = "/api/cloud/health?after=0";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = mintNonce();
    let bad;
    try {
      bad = await fetch(`${publicUrl}${target}`, {
        headers: {
          "x-omb-cloud-timestamp": timestamp,
          "x-omb-cloud-nonce": nonce,
          "x-omb-cloud-signature": "v1=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      });
    } catch (error) {
      throw new Error(`wrong-signature negative fetch failed: ${describeFetchError(error)}`);
    }
    const badBody = await bad.json().catch(() => ({}));
    if (bad.status !== 401 || badBody.error !== "invalid_signature") {
      throw new Error(`wrong-signature negative expected 401 invalid_signature, got ${bad.status} ${JSON.stringify(badBody)}`);
    }
    report.negatives.wrongSignature = { status: bad.status, error: badBody.error };
    report.steps.push(log("negative_wrong_signature", report.negatives.wrongSignature));
  }

  {
    const target = "/api/cloud/health?after=0";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = mintNonce();
    const signature = adminRequestSignature(secret, timestamp, nonce, "GET", target, "");
    const headers = {
      "x-omb-cloud-timestamp": timestamp,
      "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${signature}`,
    };
    let first;
    try {
      first = await fetch(`${publicUrl}${target}`, { headers });
    } catch (error) {
      throw new Error(`replay setup fetch failed: ${describeFetchError(error)}`);
    }
    if (first.status !== 200) {
      const body = await first.text();
      throw new Error(`replay setup request failed: ${first.status} ${body.slice(0, 200)}`);
    }
    const replay = await fetch(`${publicUrl}${target}`, { headers });
    const replayBody = await replay.json().catch(() => ({}));
    if (replay.status !== 401 || replayBody.error !== "replayed_request") {
      throw new Error(`replay negative expected 401 replayed_request, got ${replay.status} ${JSON.stringify(replayBody)}`);
    }
    report.negatives.replayedNonce = { status: replay.status, error: replayBody.error };
    report.steps.push(log("negative_replayed_nonce", report.negatives.replayedNonce));
  }

  // Sleep 409 on the green run was prepareSleep busy:["just-woke"] — the home
  // refuses sleep for CLOUD_IDLE_AWAKE_MS (2 min). Admin polls then Fly stop.
  log("sleep_begin", { note: "wait idle (just-woke), prepareSleep, Fly stop" });
  const sleepRes = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/sleep`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader() },
    body: JSON.stringify({ idleMinutes: 1, waitMs: 5 * 60_000 }),
  });
  const sleepBody = await sleepRes.json().catch(() => ({}));
  if (sleepRes.status !== 200 || sleepBody.ok !== true) {
    throw new Error(`sleep failed: ${sleepRes.status} ${JSON.stringify(sleepBody)}`);
  }
  if (sleepBody.machineState !== "stopped" && sleepBody.machineState !== "suspended") {
    throw new Error(`sleep did not suspend/stop machine: ${JSON.stringify(sleepBody)}`);
  }
  report.steps.push(log("sleep", {
    status: sleepRes.status,
    machineState: sleepBody.machineState,
    machineId: sleepBody.machineId ?? null,
  }));
  await logMachineState("after_sleep");

  const asleepMachine = await fly.getMachine(appName, flyMachineId);
  if (asleepMachine.state !== "stopped" && asleepMachine.state !== "suspended") {
    throw new Error(`assert asleep failed: state=${asleepMachine.state}`);
  }
  report.steps.push(log("assert_asleep", { state: asleepMachine.state, machineId: asleepMachine.id }));

  const probeAsleep = spawnSync(
    process.execPath,
    ["--experimental-strip-types", path.join(ROOT, "scripts/fizot/fly-cost-probe.mjs"),
      `--app=${appName}`, `--org=${org}`, "--phase=asleep", "--sample-seconds=60",
      `--expect-state=${asleepMachine.state}`,
      `--max-seconds=${Math.min(120, MAX_PROBE_MACHINE_SECONDS)}`],
    { env: process.env, encoding: "utf8" },
  );
  if (probeAsleep.status !== 0) {
    console.error(probeAsleep.stderr || probeAsleep.stdout);
    throw new Error(`asleep cost probe failed (${probeAsleep.status})`);
  }
  console.log(probeAsleep.stdout);
  report.steps.push(log("cost_probe_asleep", { exit: probeAsleep.status, expectState: asleepMachine.state }));

  // Call the service directly (same process): HTTP to the in-process Admin
  // briefly ECONNRESET after suspend on CI runners.
  log("wake_begin");
  let wakeBody = null;
  let wakeError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const woke = await admin.services.workspaceWake(workspaceId, { healthWaitMs: 3 * 60_000 });
      wakeBody = woke.body;
      wakeError = null;
      break;
    } catch (error) {
      wakeError = error;
      report.steps.push(log("wake_retry", {
        attempt,
        message: error instanceof Error ? error.message : String(error),
      }));
      await sleep(5_000);
    }
  }
  if (!wakeBody || wakeBody.ok !== true) {
    throw new Error(`wake failed: ${wakeError instanceof Error ? wakeError.message : JSON.stringify(wakeBody)}`);
  }
  report.steps.push(log("wake", {
    status: 200,
    machineState: wakeBody.machineState ?? null,
    healthOk: true,
  }));
  await logMachineState("after_wake");

  const healthAfterWake = await admin.services.workspaceHealth(workspaceId);
  if (healthAfterWake.status !== 200) {
    throw new Error(`health after wake failed: ${healthAfterWake.status} ${JSON.stringify(healthAfterWake.body)}`);
  }
  report.steps.push(log("health_after_wake", { status: healthAfterWake.status }));

  log("destroy_begin", { appName });
  const destroyed = await fetch(`${admin.url}/admin/workspaces/${workspaceId}`, {
    method: "DELETE",
    headers: cookieHeader(),
  });
  const destroyedBody = await destroyed.json().catch(() => ({}));
  if (!destroyed.ok) throw new Error(`destroy failed: ${destroyed.status} ${JSON.stringify(destroyedBody)}`);
  report.steps.push(log("destroy", { status: destroyed.status, appName }));
  workspaceId = "";

  await sleep(3_000);
  const leftover = await fly.getApp(appName);
  if (leftover) throw new Error(`Fly app ${appName} still present after destroy`);
  const stagingApps = (await fly.listApps(org)).filter((a) => a.name === appName);
  if (stagingApps.length > 0) throw new Error(`listApps still shows ${appName}`);
  report.steps.push(log("assert_gone", { appName, gone: true }));

  report.ok = true;
  report.flyCost = {
    note: "see artifacts/s2-10/*.json for measured machine seconds / volume",
    projectedDaily: projectDailyCost({}),
  };
} finally {
  if (appName) {
    try {
      const still = await fly.getApp(appName);
      if (still) {
        log("cleanup_force_destroy", { appName });
        await fly.destroyApp(appName);
      }
    } catch (error) {
      log("cleanup_error", { message: error instanceof Error ? error.message : String(error) });
    }
  }
  try {
    const remaining = (await fly.listApps(org))
      .filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX))
      .map((a) => a.name);
    log("staging_apps_remaining", { remaining, count: remaining.length });
  } catch (error) {
    log("staging_apps_remaining_error", { message: error instanceof Error ? error.message : String(error) });
  }
  await admin.close();
}

writeFileSync(path.join(ARTIFACTS, "roundtrip-report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  console.error("fly-staging-roundtrip FAILED");
  process.exit(1);
}
log("roundtrip_ok", { prefix: FLY_STAGING_APP_PREFIX });
