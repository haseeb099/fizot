#!/usr/bin/env node
/**
 * P4.7 SE-I Fly staging isolation (TC28/TC52/TC54/TC59).
 * Two disposable fizot-cm-* tenants; policy + flyctl guest network probes;
 * redacted evidence; cleanup both apps. Never production.
 * Invoked by fly-staging-roundtrip.mjs when FIZOT_ROUNDTRIP_MODE=isolation,
 * or directly with the same Fly env as the roundtrip.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createAdminServer,
  createFlyMachinesClient,
  FakeAuthProvider,
  formatCostProjection,
  projectDailyCost,
  FLY_STAGING_APP_PREFIX,
  resolveFlyOrg,
  MAX_STAGING_MACHINES,
  describeFetchError,
} from "../../server/fizot/admin/index.ts";
import {
  assertStagingConfigPresent,
  assertStagingTargetSafe,
  buildIsolationCases,
  buildIsolationEvidence,
  cleanupIsolationTenants,
  networkProbeGuestScript,
  parseNetworkProbeOutput,
  runIsolationCases,
} from "../../server/fizot/sandbox/isolation-harness.ts";
import {
  createEmptyRunManifest,
  isolationAcceptanceOk,
  recordCreatedApp,
  resolveRunManifestPath,
  writeRunManifestFile,
} from "../../server/fizot/admin/staging-safety.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ARTIFACTS = path.join(ROOT, "artifacts", "fly-staging");
mkdirSync(ARTIFACTS, { recursive: true });
const MANIFEST_PATH = resolveRunManifestPath(process.env, ROOT);
let runManifest = createEmptyRunManifest({
  flyOrg: resolveFlyOrg(),
  mode: "isolation",
  workflowRunId: process.env.GITHUB_RUN_ID?.trim() || null,
});
writeRunManifestFile(MANIFEST_PATH, runManifest);

function persistCreatedApp(name) {
  runManifest = recordCreatedApp(runManifest, name);
  writeRunManifestFile(MANIFEST_PATH, runManifest);
  log("run_manifest_recorded", { appName: name, appNames: runManifest.appNames });
}

const HEALTH_DEADLINE_MS = 8 * 60_000;
const EARLY_FAIL_MS = 3 * 60_000;
const MACHINE_LOG_EVERY_MS = 60_000;
const NETWORK_TIMEOUT_MS = Number(process.env.FIZOT_ISOLATION_PROBE_TIMEOUT_MS ?? "3000");

function log(step, detail = {}) {
  const line = { step, at: new Date().toISOString(), ...detail };
  console.log(JSON.stringify(line));
  return line;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function gitSha() {
  const fromEnv = process.env.GITHUB_SHA?.trim() || process.env.FIZOT_GIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: ROOT });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

function workflowRunUrl() {
  const server = process.env.GITHUB_SERVER_URL?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  const runId = process.env.GITHUB_RUN_ID?.trim();
  if (server && repo && runId) return `${server}/${repo}/actions/runs/${runId}`;
  return null;
}

const token = process.env.FLY_API_TOKEN?.trim() ?? "";
const org = resolveFlyOrg();
const region = process.env.FLY_REGION?.trim() ?? "lhr";
const image = process.env.FIZOT_MACHINE_IMAGE?.trim() ?? "";

assertStagingConfigPresent({ token, org, image });
assertStagingTargetSafe({ org, env: process.env });

console.log(formatCostProjection(projectDailyCost({})));
log("cost_projection_printed", { mode: "isolation" });

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

const trackedAppNames = new Set();
const report = { mode: "isolation", steps: [], ok: false, isolation: null, flyCost: null };
let workspaceId = "";
let appName = "";
let flyMachineId = "";
let sessionCookie = "";

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
    report.steps.push(log("machine_state", {
      reason,
      state: machine?.state ?? "missing",
      machineId: machine?.id ?? null,
      machineCount: machines.length,
    }));
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

async function eraseWorkspaceAndAssert(wsId, app, cookie) {
  const destroyed = await fetch(`${admin.url}/admin/workspaces/${wsId}`, {
    method: "DELETE",
    headers: cookieHeader(cookie),
  });
  const destroyedBody = await destroyed.json().catch(() => ({}));
  if (destroyed.status !== 202 && !destroyed.ok) {
    throw new Error(`destroy failed: ${destroyed.status} ${JSON.stringify(destroyedBody)}`);
  }
  report.steps.push(log("destroy_enqueued", { status: destroyed.status, appName: app, workspaceId: wsId }));

  let receipt = null;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    receipt = await admin.services.runDeletionJob(wsId);
    if (receipt.status === "complete") break;
    if (receipt.status === "failed") {
      throw new Error(`deletion failed: ${JSON.stringify(receipt)}`);
    }
    await sleep(5_000);
  }
  if (!receipt || receipt.status !== "complete") {
    throw new Error(`deletion did not complete: ${JSON.stringify(receipt)}`);
  }

  const appAfter = await fly.getApp(app);
  if (appAfter) throw new Error(`Fly app ${app} still present after erase (expected 404)`);
  const row = await admin.services.store.get(wsId);
  if (row) throw new Error(`workspace row still present for ${wsId}`);
  return receipt;
}

function networkProbeOnMachine(app, machineId, host, port, timeoutMs) {
  const script = networkProbeGuestScript(host, port, timeoutMs);
  const args = ["ssh", "console", "-a", app, "-C", `node -e ${JSON.stringify(script)}`];
  if (machineId) args.push("--machine", machineId);
  const r = spawnSync("flyctl", args, {
    encoding: "utf8",
    timeout: timeoutMs + 20_000,
    env: process.env,
  });
  if (r.error && r.error.code === "ENOENT") {
    return {
      kind: "error",
      layer: "network",
      message: "flyctl not installed; network probe skipped",
      class: "unrelated",
    };
  }
  return parseNetworkProbeOutput({
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status,
    timeoutMs,
  });
}

try {
  const projection = projectDailyCost({});
  log("isolation_begin", {
    maxStagingMachines: MAX_STAGING_MACHINES,
    probeTimeoutMs: NETWORK_TIMEOUT_MS,
    note: "two disposable fizot-cm-* apps; never production",
  });

  const ownerA = "isolation-a@fizot.test";
  const ownerB = "isolation-b@fizot.test";
  const signedA = await signIn(ownerA);
  sessionCookie = signedA.cookie;
  report.steps.push(log("sign_in", { email: ownerA }));

  async function createTenant(label, cookie, email) {
    const created = await fetch(`${admin.url}/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        plan: "home",
        ownerEmail: email,
        requestId: `iso-${label}-${Date.now().toString(36)}`,
      }),
    });
    const body = await created.json().catch(() => ({}));
    if (!created.ok) {
      throw new Error(`create tenant ${label} failed: ${created.status} ${JSON.stringify(body)}`);
    }
    workspaceId = body.workspace.id;
    appName = body.workspace.appName;
    flyMachineId = body.workspace.flyMachineId ?? "";
    trackedAppNames.add(appName);
    persistCreatedApp(appName);
    assertStagingTargetSafe({ org, appNames: [appName], env: process.env });
    const stored = await admin.services.store.get(workspaceId);
    if (!stored) throw new Error(`tenant ${label} missing from store after create`);
    flyMachineId = stored.flyMachineId || flyMachineId;
    sessionCookie = cookie;
    await waitForHealth();
    const machine = await fly.getMachine(appName, flyMachineId).catch(async () => {
      const list = await fly.listMachines(appName);
      return list[0] ?? null;
    });
    const privateIp = machine?.privateIp?.trim() ?? "";
    if (!privateIp) {
      throw new Error(`tenant ${label} machine missing privateIp (cannot prove TC28/TC54/TC59)`);
    }
    report.steps.push(log("tenant_ready", {
      label,
      workspaceId,
      appName,
      flyMachineId: machine?.id ?? flyMachineId,
      privateIp,
      network: stored.network,
    }));
    return {
      label,
      workspaceId,
      appName,
      flyMachineId: machine?.id ?? flyMachineId,
      privateIp,
      network: stored.network,
      cookie,
    };
  }

  const tenantA = await createTenant("A", signedA.cookie, ownerA);
  const signedB = await signIn(ownerB);
  const tenantB = await createTenant("B", signedB.cookie, ownerB);

  workspaceId = "";
  appName = "";
  flyMachineId = "";

  const cases = buildIsolationCases({
    selfPrivateIp: tenantA.privateIp,
    peerPrivateIp: tenantB.privateIp,
  });
  const caseResults = await runIsolationCases({
    cases,
    selfAddresses: new Set([tenantA.privateIp]),
    networkProbe: async (target) => networkProbeOnMachine(
      tenantA.appName,
      tenantA.flyMachineId,
      target.host,
      target.port,
      NETWORK_TIMEOUT_MS,
    ),
  });
  report.steps.push(log("isolation_cases", {
    results: caseResults.map((r) => ({
      id: r.id,
      layer: r.layer,
      verdict: r.verdict,
      refusalReason: r.refusalReason,
      destinationClass: r.destinationClass,
    })),
  }));

  const cleanup = await cleanupIsolationTenants({
    appNames: [tenantA.appName, tenantB.appName],
    destroyApp: async (name) => {
      const row = [tenantA, tenantB].find((t) => t.appName === name);
      if (row) {
        try {
          await eraseWorkspaceAndAssert(row.workspaceId, row.appName, row.cookie);
          trackedAppNames.delete(name);
          return;
        } catch (error) {
          log("isolation_erase_fallback", {
            appName: name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await fly.destroyApp(name);
      trackedAppNames.delete(name);
    },
    listStagingApps: async () => (await fly.listApps(org))
      .filter((a) => a.name.startsWith(FLY_STAGING_APP_PREFIX))
      .map((a) => a.name),
  });

  const evidence = buildIsolationEvidence({
    gitSha: gitSha(),
    environmentType: "staging-fly",
    flyOrg: org,
    workflowRunUrl: workflowRunUrl(),
    tenants: [
      {
        label: "A",
        workspaceId: tenantA.workspaceId,
        appName: tenantA.appName,
        flyMachineId: tenantA.flyMachineId,
        privateIp: tenantA.privateIp,
        network: tenantA.network,
      },
      {
        label: "B",
        workspaceId: tenantB.workspaceId,
        appName: tenantB.appName,
        flyMachineId: tenantB.flyMachineId,
        privateIp: tenantB.privateIp,
        network: tenantB.network,
      },
    ],
    cases: caseResults,
    cleanup,
    costGuard: {
      maxStagingMachines: MAX_STAGING_MACHINES,
      projectedDailyUsd: projection.totalUsdPerDay,
      note: "two concurrent staging machines at Gate G0b cap; destroy both before exit",
    },
  });
  writeFileSync(
    path.join(ARTIFACTS, "isolation-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  report.isolation = {
    summary: evidence.summary,
    cleanup: evidence.cleanup.outcome,
    evidencePath: "artifacts/fly-staging/isolation-evidence.json",
  };
  report.flyCost = {
    note: "isolation mode: two machines for bounded probe window",
    projectedDaily: projection,
  };
  report.ok = isolationAcceptanceOk({
    probeOverall: evidence.summary.overall,
    cleanupOutcome: cleanup.outcome,
  });
  if (evidence.summary.overall !== "PASS") {
    throw new Error(`isolation overall=${evidence.summary.overall} (see isolation-evidence.json)`);
  }
  if (cleanup.outcome !== "ok") {
    throw new Error(`isolation cleanup ${cleanup.outcome}: ${cleanup.error ?? "remaining apps"}`);
  }
} finally {
  const forceDestroy = new Set(trackedAppNames);
  if (appName) forceDestroy.add(appName);
  for (const name of forceDestroy) {
    try {
      const still = await fly.getApp(name);
      if (still) {
        log("cleanup_force_destroy", { appName: name });
        await fly.destroyApp(name);
      }
    } catch (error) {
      log("cleanup_error", {
        appName: name,
        message: error instanceof Error ? error.message : String(error),
      });
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

writeFileSync(path.join(ARTIFACTS, "isolation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  console.error("fly-staging-isolation FAILED");
  process.exit(1);
}
if (typeof report.remainingCount === "number" && report.remainingCount !== 0) {
  console.error(`staging_apps_remaining count=${report.remainingCount} (expected 0)`);
  process.exit(1);
}
log("isolation_ok", { prefix: FLY_STAGING_APP_PREFIX });
