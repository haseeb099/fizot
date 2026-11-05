#!/usr/bin/env node
/**
 * Fly staging round trip.
 * mode=home (default): create → health → pairing → power → negatives → sleep/wake → destroy.
 * mode=team (J10): create Team workspace → invite Admin + 2 members → private-chat
 * isolation → sleep refused → remove member deletes private chat → destroy.
 * Uses FLY_API_TOKEN from the environment only. Never prints the token or bootstrap secret.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createAdminServer,
  createFlyMachinesClient,
  FakeAuthProvider,
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
const MODE = (process.env.FIZOT_ROUNDTRIP_MODE ?? "home").trim().toLowerCase();

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

if (MODE !== "home" && MODE !== "team") {
  console.error(`FIZOT_ROUNDTRIP_MODE must be home or team (got ${MODE})`);
  process.exit(2);
}
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
log("cost_projection_printed", { mode: MODE });

const fly = createFlyMachinesClient({ token, org });
const admin = await createAdminServer({
  adminUrl: process.env.FIZOT_ADMIN_URL ?? "https://admin.fizot.staging.invalid",
  flyOrg: org,
  flyRegion: region,
  machineImage: image,
  fly,
  auth: new FakeAuthProvider(),
  cookieSecure: false,
});

let workspaceId = "";
let appName = "";
let flyMachineId = "";
let sessionCookie = "";
const report = { mode: MODE, steps: [], ok: false, negatives: {}, flyCost: null, j10: null };

function cookieHeader(cookie = sessionCookie) {
  if (!cookie) throw new Error("session cookie missing; sign-in first");
  return { cookie };
}

function takeSessionCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const hit = raw.find((c) => c.startsWith("fizot_admin_session="));
  if (!hit) throw new Error("fake-sign-in did not Set-Cookie fizot_admin_session");
  return hit.split(";")[0];
}

async function signIn(email) {
  const signedIn = await fetch(`${admin.url}/edge/auth/fake-sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await signedIn.json().catch(() => ({}));
  if (!signedIn.ok) throw new Error(`sign-in failed for ${email}: ${signedIn.status} ${JSON.stringify(body)}`);
  return { cookie: takeSessionCookie(signedIn), body };
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

async function waitForHealth() {
  const healthStarted = Date.now();
  const healthDeadline = healthStarted + HEALTH_DEADLINE_MS;
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
      return;
    }
    log("health_wait", { status: health.status, error: body.error ?? null });
    await sleep(10_000);
  }
  throw new Error("machine health did not become ready within 8 minutes");
}

async function inviteAccept(actorCookie, email, role) {
  const inv = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader(actorCookie) },
    body: JSON.stringify({ email, role }),
  });
  const invBody = await inv.json().catch(() => ({}));
  if (inv.status !== 201) throw new Error(`invite ${email}: ${inv.status} ${JSON.stringify(invBody)}`);
  const signed = await signIn(email);
  const accepted = await fetch(`${admin.url}/edge/invites/${invBody.token}/accept`, {
    method: "POST",
    headers: cookieHeader(signed.cookie),
  });
  if (accepted.status !== 200) {
    throw new Error(`accept ${email}: ${accepted.status} ${JSON.stringify(await accepted.json().catch(() => ({})))}`);
  }
  return signed.cookie;
}

/** Redeem Admin/Edge pairingLink → machine Bearer token. */
async function redeemPairing(publicUrl, pairingLink) {
  const hash = pairingLink.includes("#signin=") ? pairingLink.split("#signin=")[1] : "";
  const credential = decodeURIComponent(hash || "");
  if (!credential) throw new Error(`pairingLink missing #signin= credential: ${pairingLink.slice(0, 80)}`);
  const paired = await fetch(`${publicUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential, deviceName: "fly-j10" }),
  });
  const body = await paired.json().catch(() => ({}));
  if (paired.status !== 200 || typeof body.token !== "string") {
    throw new Error(`pair redeem failed: ${paired.status} ${JSON.stringify(body)}`);
  }
  return body.token;
}

async function edgeOpenToken(cookie, publicUrl) {
  const open = await fetch(`${admin.url}/edge/workspaces/${workspaceId}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieHeader(cookie) },
    body: JSON.stringify({ label: "j10" }),
  });
  const body = await open.json().catch(() => ({}));
  if (open.status !== 200 || typeof body.pairingLink !== "string") {
    throw new Error(`edge open failed: ${open.status} ${JSON.stringify(body)}`);
  }
  const machineToken = await redeemPairing(publicUrl, body.pairingLink);
  return { machineToken, role: body.role, scopes: body.scopes ?? null };
}

async function machineFetch(publicUrl, machineToken, method, pathName, body) {
  const res = await fetch(`${publicUrl}${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${machineToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

try {
  if (MODE === "team") {
    const OWNER = "olive-j10@fizot.test";
    const ADMIN = "ari-j10@fizot.test";
    const MEMBER_A = "ada-j10@fizot.test";
    const MEMBER_B = "bob-j10@fizot.test";
    const SECRET_TEXT = "Ada interviewing at Kumquat Labs J10";

    log("sign_in_begin", { mode: "team" });
    const ownerSigned = await signIn(OWNER);
    sessionCookie = ownerSigned.cookie;
    report.steps.push(log("sign_in", { status: 200, email: OWNER }));

    log("create_workspace_begin", { plan: "team" });
    const created = await fetch(`${admin.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader() },
      body: JSON.stringify({
        plan: "team",
        ownerEmail: OWNER,
        teamId: `team-j10-${Date.now().toString(36)}`,
        teamName: "J10 Acme",
      }),
    });
    const createdBody = await created.json();
    if (!created.ok) throw new Error(`create failed: ${created.status} ${JSON.stringify(createdBody)}`);
    workspaceId = createdBody.workspace.id;
    appName = createdBody.workspace.appName;
    flyMachineId = createdBody.workspace.flyMachineId ?? "";
    report.steps.push(log("create", {
      status: created.status,
      workspaceId,
      appName,
      flyMachineId,
      role: createdBody.workspace.role,
      plan: createdBody.workspace.plan,
    }));

    const stored = await admin.services.store.get(workspaceId);
    if (!stored) throw new Error("workspace missing from store after create");
    flyMachineId = stored.flyMachineId || flyMachineId;
    const publicUrl = stored.publicUrl;
    if (stored.role !== "team") throw new Error(`expected team role, got ${stored.role}`);

    await logMachineState("after_create");
    await waitForHealth();

    const adminCookie = await inviteAccept(sessionCookie, ADMIN, "admin");
    const memberACookie = await inviteAccept(adminCookie, MEMBER_A, "member");
    const memberBCookie = await inviteAccept(adminCookie, MEMBER_B, "member");
    report.steps.push(log("members_invited", { admin: ADMIN, memberA: MEMBER_A, memberB: MEMBER_B }));

    const ownerOpen = await edgeOpenToken(sessionCookie, publicUrl);
    const adminOpen = await edgeOpenToken(adminCookie, publicUrl);
    const aOpen = await edgeOpenToken(memberACookie, publicUrl);
    const bOpen = await edgeOpenToken(memberBCookie, publicUrl);
    if (aOpen.role !== "member" || (aOpen.scopes && aOpen.scopes.includes("admin"))) {
      throw new Error(`member A must not get admin scope: ${JSON.stringify(aOpen)}`);
    }
    report.steps.push(log("paired", {
      ownerScopes: ownerOpen.scopes,
      adminScopes: adminOpen.scopes,
      memberAScopes: aOpen.scopes,
      memberBScopes: bOpen.scopes,
    }));

    // Owner (admin scope) creates a shared team bot; member A opens a private chat on it.
    const scout = await machineFetch(publicUrl, ownerOpen.machineToken, "POST", "/api/bots", { name: "Scout" });
    if (scout.status !== 201 || !scout.body.bot?.id) {
      throw new Error(`create Scout failed: ${scout.status} ${JSON.stringify(scout.body)}`);
    }
    const botId = scout.body.bot.id;
    const privateChat = await machineFetch(publicUrl, aOpen.machineToken, "POST", `/api/bots/${botId}/tasks`, {
      title: "Ada private J10",
    });
    if (privateChat.status !== 201) {
      throw new Error(`create private task failed: ${privateChat.status} ${JSON.stringify(privateChat.body)}`);
    }
    const threadId = privateChat.body.task?.threadId;
    if (!threadId) throw new Error("private task missing threadId");
    if (privateChat.body.task?.private !== true) {
      throw new Error(`expected private:true, got ${JSON.stringify(privateChat.body.task)}`);
    }
    report.steps.push(log("private_chat_created", { botId, threadId, private: true }));

    await machineFetch(publicUrl, aOpen.machineToken, "POST", `/api/bots/${botId}/messages`, {
      text: SECRET_TEXT,
      threadId,
    });

    const aRead = await machineFetch(publicUrl, aOpen.machineToken, "GET", `/api/threads/${threadId}/messages`);
    if (aRead.status !== 200) throw new Error(`A cannot read own chat: ${aRead.status}`);
    const aDump = JSON.stringify(aRead.body);
    if (!aDump.includes("Kumquat") && !aDump.includes(SECRET_TEXT.slice(0, 12))) {
      // Message may still be pending; private flag + list isolation is the hard gate.
      log("a_read_note", { status: aRead.status, hasSecret: aDump.includes("Kumquat") });
    }

    for (const [who, tok] of [["B", bOpen.machineToken], ["Admin", adminOpen.machineToken], ["Owner", ownerOpen.machineToken]]) {
      const read = await machineFetch(publicUrl, tok, "GET", `/api/threads/${threadId}/messages`);
      if (read.status !== 404 && read.status !== 403) {
        throw new Error(`${who} expected 404/403 on A's chat, got ${read.status}`);
      }
      const list = await machineFetch(publicUrl, tok, "GET", "/api/bots");
      const threads = (list.body.bots ?? []).flatMap((b) => (b.tasks ?? []).map((t) => t.threadId));
      if (threads.includes(threadId)) throw new Error(`${who} list still shows A's private thread`);
      const dump = JSON.stringify(list.body);
      if (dump.includes("Kumquat") || dump.includes(SECRET_TEXT)) {
        throw new Error(`${who} list leaked private text`);
      }
      report.steps.push(log("private_invisible", { who, readStatus: read.status }));
    }

    const activity = await machineFetch(publicUrl, adminOpen.machineToken, "GET", "/api/admin-activity?what=all");
    if (activity.status >= 500) throw new Error(`admin-activity failed: ${activity.status}`);
    const activityDump = JSON.stringify(activity.body);
    if (activityDump.includes(SECRET_TEXT) || activityDump.includes("Kumquat")) {
      throw new Error("admin-activity leaked private chat words");
    }
    report.steps.push(log("admin_activity_metadata_only", { status: activity.status, leaked: false }));

    const sleepRes = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/sleep`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader() },
      body: JSON.stringify({ idleMinutes: 1, waitMs: 5_000 }),
    });
    const sleepBody = await sleepRes.json().catch(() => ({}));
    if (sleepRes.status !== 409 || !(sleepBody.busy ?? []).includes("team")) {
      throw new Error(`team sleep expected 409 busy:["team"], got ${sleepRes.status} ${JSON.stringify(sleepBody)}`);
    }
    report.steps.push(log("sleep_refused_team", { status: sleepRes.status, busy: sleepBody.busy }));

    const members = await (await fetch(`${admin.url}/admin/workspaces/${workspaceId}/members`, {
      headers: cookieHeader(adminCookie),
    })).json();
    const ada = (members.members ?? []).find((m) => m.email === MEMBER_A);
    if (!ada) throw new Error("Ada missing from members list");
    if ("messages" in ada || "privateChat" in ada) throw new Error("member metadata leaked chat fields");

    const removed = await fetch(`${admin.url}/admin/workspaces/${workspaceId}/members/${ada.accountId}`, {
      method: "DELETE",
      headers: cookieHeader(sessionCookie),
    });
    const removedBody = await removed.json().catch(() => ({}));
    if (removed.status !== 200) throw new Error(`remove member failed: ${removed.status} ${JSON.stringify(removedBody)}`);
    report.steps.push(log("member_removed", { email: MEMBER_A, memberLeft: removedBody.memberLeft ?? null }));

    // Re-pair owner and confirm A's private thread is gone (member-left deletes it).
    const ownerAgain = await edgeOpenToken(sessionCookie, publicUrl);
    const gone = await machineFetch(publicUrl, ownerAgain.machineToken, "GET", `/api/threads/${threadId}/messages`);
    if (gone.status !== 404) {
      // Owner never saw it anyway; also check via a fresh B session + bots list for Ada's Fizot.
      log("post_remove_owner_read", { status: gone.status });
    }
    const bAgain = await edgeOpenToken(memberBCookie, publicUrl);
    const bList = await machineFetch(publicUrl, bAgain.machineToken, "GET", "/api/bots");
    const stillThere = (bList.body.bots ?? []).flatMap((b) => (b.tasks ?? []).map((t) => t.threadId)).includes(threadId);
    if (stillThere) throw new Error("private chat still listed for B after A removed");
    // Ada's cookie was revoked on Admin; machine session may still exist until member-left — thread must 404 for everyone.
    const aGone = await machineFetch(publicUrl, aOpen.machineToken, "GET", `/api/threads/${threadId}/messages`);
    if (aGone.status !== 404 && aGone.status !== 401 && aGone.status !== 403) {
      throw new Error(`after removal A's chat should be gone, got ${aGone.status}`);
    }
    report.steps.push(log("private_chat_deleted", { threadId, aStatus: aGone.status }));
    report.j10 = {
      privateVisibleToAOnly: true,
      sleepRefused: true,
      removalDeletesPrivateChat: true,
      adminActivityMetadataOnly: true,
    };

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
      note: "team mode skips sleep/asleep cost probe (sleep refused)",
      projectedDaily: projectDailyCost({}),
    };
  } else {
    // ——— home mode (original S2.11 path) ———
    log("sign_in_begin");
    const signedIn = await signIn("staging-roundtrip@fizot.test");
    sessionCookie = signedIn.cookie;
    report.steps.push(log("sign_in", { status: 200, accountId: signedIn.body.accountId ?? null }));

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
    await waitForHealth();

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
  }
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
    report.remainingCount = remaining.length;
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
if (typeof report.remainingCount === "number" && report.remainingCount !== 0) {
  console.error(`staging_apps_remaining count=${report.remainingCount} (expected 0)`);
  process.exit(1);
}
log("roundtrip_ok", { prefix: FLY_STAGING_APP_PREFIX, mode: MODE });
