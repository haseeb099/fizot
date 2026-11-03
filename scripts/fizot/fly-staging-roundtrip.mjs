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
} from "../../server/fizot/admin/index.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACTS = path.join(ROOT, "artifacts", "fly-staging");
mkdirSync(ARTIFACTS, { recursive: true });

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
});

let workspaceId = "";
let appName = "";
const report = { steps: [], ok: false, negatives: {}, flyCost: null };

try {
  log("create_workspace_begin");
  const created = await fetch(`${admin.url}/admin/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "home", ownerEmail: "staging-roundtrip@fizot.test" }),
  });
  const createdBody = await created.json();
  if (!created.ok) throw new Error(`create failed: ${created.status} ${JSON.stringify(createdBody)}`);
  workspaceId = createdBody.workspace.id;
  appName = createdBody.workspace.appName;
  report.steps.push(log("create", { status: created.status, workspaceId, appName }));

  const stored = await admin.services.store.get(workspaceId);
  if (!stored) throw new Error("workspace missing from store after create");
  const publicUrl = stored.publicUrl;
  const secret = stored.bootstrapSecret;

  const healthDeadline = Date.now() + 8 * 60_000;
  let healthOk = false;
  while (Date.now() < healthDeadline) {
    const health = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/health`);
    const body = await health.json().catch(() => ({}));
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "staging-roundtrip", ttlSeconds: 120 }),
  });
  const pairingBody = await pairing.json().catch(() => ({}));
  if (pairing.status !== 200) throw new Error(`pairing failed: ${pairing.status}`);
  if (typeof pairingBody.pairingLink !== "string" || !pairingBody.pairingLink.includes("/pair#signin=")) {
    throw new Error("pairing response missing pairingLink");
  }
  report.steps.push(log("pairing", { status: pairing.status, hasLink: true }));

  const power = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/power`);
  const powerBody = await power.json().catch(() => ({}));
  if (power.status !== 200) throw new Error(`power failed: ${power.status}`);
  report.steps.push(log("power", { status: power.status, state: powerBody.state ?? powerBody }));

  // Awake cost sample (short; hard-capped by the probe itself).
  const probeAwake = spawnSync(
    process.execPath,
    ["--experimental-strip-types", path.join(ROOT, "scripts/fizot/fly-cost-probe.mjs"),
      `--app=${appName}`, `--org=${org}`, "--phase=awake", "--sample-seconds=25",
      `--max-seconds=${Math.min(120, MAX_PROBE_MACHINE_SECONDS)}`],
    { env: process.env, encoding: "utf8" },
  );
  if (probeAwake.status !== 0) {
    console.error(probeAwake.stderr || probeAwake.stdout);
    throw new Error(`awake cost probe failed (${probeAwake.status})`);
  }
  console.log(probeAwake.stdout);
  report.steps.push(log("cost_probe_awake", { exit: probeAwake.status }));

  // Negative: wrong signature against the real machine.
  {
    const target = "/api/cloud/health?after=0";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = mintNonce();
    const bad = await fetch(`${publicUrl}${target}`, {
      headers: {
        "x-omb-cloud-timestamp": timestamp,
        "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": "v1=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    const badBody = await bad.json().catch(() => ({}));
    if (bad.status !== 401 || badBody.error !== "invalid_signature") {
      throw new Error(`wrong-signature negative expected 401 invalid_signature, got ${bad.status} ${JSON.stringify(badBody)}`);
    }
    report.negatives.wrongSignature = { status: bad.status, error: badBody.error };
    report.steps.push(log("negative_wrong_signature", report.negatives.wrongSignature));
  }

  // Negative: replayed nonce against the real machine.
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
    const first = await fetch(`${publicUrl}${target}`, { headers });
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

  // Best-effort sleep then asleep probe (machine may refuse sleep on staging image).
  try {
    const sleepPath = "/api/cloud/power/sleep";
    const sleepBody = Buffer.from(JSON.stringify({}));
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = mintNonce();
    const sig = adminRequestSignature(secret, ts, nonce, "POST", sleepPath, sleepBody);
    const sleepRes = await fetch(`${publicUrl}${sleepPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-omb-cloud-timestamp": ts,
        "x-omb-cloud-nonce": nonce,
        "x-omb-cloud-signature": `v1=${sig}`,
      },
      body: sleepBody,
    });
    report.steps.push(log("sleep_attempt", { status: sleepRes.status }));
    await sleep(5_000);
    const probeAsleep = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.join(ROOT, "scripts/fizot/fly-cost-probe.mjs"),
        `--app=${appName}`, `--org=${org}`, "--phase=asleep", "--sample-seconds=15",
        `--max-seconds=${Math.min(60, MAX_PROBE_MACHINE_SECONDS)}`],
      { env: process.env, encoding: "utf8" },
    );
    console.log(probeAsleep.stdout);
    report.steps.push(log("cost_probe_asleep", { exit: probeAsleep.status }));
  } catch (error) {
    report.steps.push(log("sleep_skipped", { reason: error instanceof Error ? error.message : String(error) }));
  }

  log("destroy_begin", { appName });
  const destroyed = await fetch(`${admin.url}/admin/workspaces/${workspaceId}`, { method: "DELETE" });
  const destroyedBody = await destroyed.json().catch(() => ({}));
  if (!destroyed.ok) throw new Error(`destroy failed: ${destroyed.status} ${JSON.stringify(destroyedBody)}`);
  report.steps.push(log("destroy", { status: destroyed.status, appName }));

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
  if (workspaceId && appName) {
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
  await admin.close();
}

writeFileSync(path.join(ARTIFACTS, "roundtrip-report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  console.error("fly-staging-roundtrip FAILED");
  process.exit(1);
}
log("roundtrip_ok", { prefix: FLY_STAGING_APP_PREFIX });
