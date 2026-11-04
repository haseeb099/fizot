import { randomBytes, randomUUID } from "node:crypto";
import { teamRoleScopes, type TeamRole } from "../../cloud-team.ts";
import { FLY_HOME_VOLUME_GB, type FlyClient } from "./fly.ts";
import type { NonceStore } from "./nonce-store.ts";
import { planFlags, type PlanId } from "./plans.ts";
import { mintBootstrapSecret, signAdminRequest } from "./signer.ts";
import type { WorkspaceRecord, WorkspaceStore } from "./store.ts";

export type AdminConfig = {
  adminUrl: string;
  flyOrg: string;
  flyRegion: string;
  machineImage: string;
  fly: FlyClient;
  store: WorkspaceStore;
  nonces: NonceStore;
  /** Signed machine HTTP for health/power/pairing. Tests inject a fake. */
  machineFetch?: typeof fetch;
  now?: () => number;
};

export type CreateWorkspaceInput = {
  plan: PlanId;
  ownerEmail?: string;
  teamId?: string;
  teamName?: string;
};

/** Surface undici/node fetch cause (code, hostname) — "fetch failed" alone is useless. */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const c = cause as { code?: string; errno?: string; hostname?: string; address?: string; message?: string };
    if (c.code || c.errno) parts.push(`code=${c.code ?? c.errno}`);
    if (c.hostname) parts.push(`hostname=${c.hostname}`);
    if (c.address) parts.push(`address=${c.address}`);
    if (c.message && c.message !== error.message) parts.push(`causeMessage=${c.message}`);
  } else if (cause != null) {
    parts.push(`cause=${String(cause)}`);
  }
  return parts.join(" ");
}

export function createAdminServices(config: AdminConfig) {
  const { nonces } = config;
  const machineFetch = config.machineFetch ?? fetch;
  const now = config.now ?? Date.now;

  async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
    const flags = planFlags(input.plan);
    if (!flags) throw Object.assign(new Error("unknown_plan"), { status: 400 });
    if (flags.role === "team" && (!input.teamId || !input.teamName)) {
      throw Object.assign(new Error("team_required"), { status: 400 });
    }
    if (flags.role === "home" && !input.ownerEmail) {
      throw Object.assign(new Error("owner_required"), { status: 400 });
    }

    const id = randomUUID();
    const machineId = `cm-${id.replace(/-/g, "").slice(0, 16)}`;
    const appName = `fizot-${machineId}`.toLowerCase();
    const network = `fizot-net-${machineId}`;
    const publicUrl = `https://${appName}.fly.dev`;
    const bootstrapSecret = mintBootstrapSecret();

    await config.fly.createApp({ appName, org: config.flyOrg, network });
    // Machines API apps have no public IP until allocated; without this, *.fly.dev fetch fails.
    await config.fly.allocateIps(appName);
    const volume = await config.fly.createVolume({
      appName,
      name: "omb_home",
      region: config.flyRegion,
      sizeGb: flags.volumeGb || FLY_HOME_VOLUME_GB,
    });
    const secrets = await config.fly.setSecrets({
      appName,
      secrets: {
        OMB_CLOUD_ADMIN_URL: config.adminUrl,
        OMB_CLOUD_BOOTSTRAP_SECRET: bootstrapSecret,
      },
    });
    const env: Record<string, string> = {
      OMB_CLOUD_ROLE: flags.role,
      OMB_CLOUD_MACHINE_ID: machineId,
      OMB_PUBLIC_URL: publicUrl,
      // Cold wake after stop: Caddy holds until the server listens (cloud-pro.md).
      OMB_CLOUD_EDGE_HOLD: "30s",
    };
    if (flags.role === "team" && input.teamId && input.teamName) {
      env.OMB_CLOUD_TEAM_ID = input.teamId;
      env.OMB_CLOUD_TEAM_NAME = input.teamName;
    }
    const machine = await config.fly.createMachine({
      appName,
      region: config.flyRegion,
      name: "home",
      image: config.machineImage,
      volumeId: volume.id,
      env,
      guest: {
        cpu_kind: "shared",
        cpus: flags.cpus,
        memory_mb: flags.memoryMb,
      },
      autoDestroy: true,
      minSecretsVersion: secrets.version || undefined,
    });

    const record: WorkspaceRecord = {
      id,
      plan: input.plan,
      appName,
      network,
      machineId,
      flyMachineId: machine.id,
      flyVolumeId: volume.id,
      publicUrl,
      role: flags.role,
      bootstrapSecret,
      createdAt: new Date(now()).toISOString(),
      ...(input.ownerEmail ? { ownerEmail: input.ownerEmail.trim().toLowerCase() } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamName ? { teamName: input.teamName } : {}),
    };
    return config.store.create(record);
  }

  async function signedMachineGet(workspace: WorkspaceRecord, pathAndQuery: string): Promise<Response> {
    const headers = await signAdminRequest({
      secret: workspace.bootstrapSecret,
      method: "GET",
      target: pathAndQuery,
      body: "",
      nonces,
      now,
    });
    try {
      return await machineFetch(`${workspace.publicUrl}${pathAndQuery}`, { method: "GET", headers });
    } catch (error) {
      throw Object.assign(new Error(describeFetchError(error)), { status: 502, cause: error });
    }
  }

  async function signedMachinePost(workspace: WorkspaceRecord, path: string, bodyObj: unknown): Promise<Response> {
    const body = Buffer.from(JSON.stringify(bodyObj));
    const headers = await signAdminRequest({
      secret: workspace.bootstrapSecret,
      method: "POST",
      target: path,
      body,
      nonces,
      now,
    });
    try {
      return await machineFetch(`${workspace.publicUrl}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      });
    } catch (error) {
      throw Object.assign(new Error(describeFetchError(error)), { status: 502, cause: error });
    }
  }

  async function workspaceHealth(id: string) {
    const workspace = await config.store.get(id);
    if (!workspace) throw Object.assign(new Error("not_found"), { status: 404 });
    const response = await signedMachineGet(workspace, "/api/cloud/health?after=0");
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, workspaceId: workspace.id };
  }

  async function workspacePower(id: string, idleMinutes?: number) {
    const workspace = await config.store.get(id);
    if (!workspace) throw Object.assign(new Error("not_found"), { status: 404 });
    const q = idleMinutes !== undefined ? `?idleMinutes=${idleMinutes}` : "";
    const response = await signedMachineGet(workspace, `/api/cloud/power${q}`);
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, workspaceId: workspace.id };
  }

  /**
   * Sleep handshake then Fly Machines stop.
   * HTTP 409 from /api/cloud/power/sleep means the home is not idle yet
   * (e.g. busy:["just-woke"] for 2 minutes after boot) — callers must wait
   * and retry; this helper polls until idle or deadline.
   */
  async function workspaceSleep(id: string, input: {
    idleMinutes?: number;
    waitMs?: number;
  } = {}) {
    const workspace = await config.store.get(id);
    if (!workspace) throw Object.assign(new Error("not_found"), { status: 404 });
    const idleMinutes = input.idleMinutes ?? 1;
    const deadline = Date.now() + (input.waitMs ?? 5 * 60_000);
    let lastBusy: unknown = null;
    while (Date.now() < deadline) {
      const power = await workspacePower(id, idleMinutes);
      const body = power.body as { idle?: boolean; busy?: unknown; wokeAt?: number };
      if (power.status === 200 && body.idle === true) break;
      lastBusy = body.busy ?? body;
      const wokeAt = typeof body.wokeAt === "number" ? body.wokeAt : 0;
      const justWokeLeft = Math.max(0, wokeAt + 120_000 - Date.now());
      await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(2_000, justWokeLeft || 5_000))));
    }
    const sleepRes = await signedMachinePost(workspace, "/api/cloud/power/sleep", {
      v: 1,
      idleMinutes,
    });
    const sleepBody = await sleepRes.json().catch(() => ({})) as { ok?: boolean; busy?: unknown; nextDueAt?: number | null };
    if (sleepRes.status !== 200) {
      throw Object.assign(
        new Error(`power_sleep_refused:${sleepRes.status}:${JSON.stringify(sleepBody.busy ?? sleepBody)}`),
        { status: sleepRes.status === 409 ? 409 : 502, body: sleepBody, lastBusy },
      );
    }
    if (!workspace.flyMachineId) {
      throw Object.assign(new Error("missing_fly_machine_id"), { status: 500 });
    }
    await config.fly.stopMachine(workspace.appName, workspace.flyMachineId, { timeout: "30s" });
    await config.fly.waitMachine(workspace.appName, workspace.flyMachineId, "stopped", { timeoutSec: 120 });
    const machine = await config.fly.getMachine(workspace.appName, workspace.flyMachineId);
    if (machine.state !== "stopped" && machine.state !== "suspended") {
      throw Object.assign(new Error(`machine_not_stopped:${machine.state}`), { status: 502 });
    }
    return {
      status: 200,
      body: { ok: true, sleep: sleepBody, machineState: machine.state, machineId: machine.id },
      workspaceId: workspace.id,
    };
  }

  async function workspaceWake(id: string, input: { healthWaitMs?: number } = {}) {
    const workspace = await config.store.get(id);
    if (!workspace) throw Object.assign(new Error("not_found"), { status: 404 });
    if (!workspace.flyMachineId) {
      throw Object.assign(new Error("missing_fly_machine_id"), { status: 500 });
    }
    await config.fly.startMachine(workspace.appName, workspace.flyMachineId);
    await config.fly.waitMachine(workspace.appName, workspace.flyMachineId, "started", { timeoutSec: 120 });
    const healthDeadline = Date.now() + (input.healthWaitMs ?? 3 * 60_000);
    let lastHealth: { status: number; body: unknown } | null = null;
    while (Date.now() < healthDeadline) {
      try {
        const health = await workspaceHealth(id);
        lastHealth = { status: health.status, body: health.body };
        const body = health.body as { ok?: boolean; v?: number };
        if (health.status === 200 && (body.ok === true || body.v === 1)) {
          const machine = await config.fly.getMachine(workspace.appName, workspace.flyMachineId);
          return {
            status: 200,
            body: { ok: true, health: health.body, machineState: machine.state },
            workspaceId: workspace.id,
          };
        }
      } catch {
        // Cold wake: edge may 502 until the process listens.
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw Object.assign(
      new Error(`wake_health_timeout:${JSON.stringify(lastHealth)}`),
      { status: 504 },
    );
  }

  async function workspacePairing(id: string, input: {
    label?: string;
    ttlSeconds?: number;
    member?: { email: string; role: TeamRole };
  }) {
    const workspace = await config.store.get(id);
    if (!workspace) throw Object.assign(new Error("not_found"), { status: 404 });
    const body: Record<string, unknown> = {
      label: input.label ?? "Fizot app (Cloud)",
      ttlSeconds: input.ttlSeconds ?? 300,
    };
    if (workspace.role === "team") {
      if (!input.member) throw Object.assign(new Error("member_required"), { status: 400 });
      body.member = input.member;
      if (workspace.teamId) body.team = { id: workspace.teamId };
      const scopes = teamRoleScopes(input.member.role);
      body._scopes = scopes;
    }
    const response = await signedMachinePost(workspace, "/api/cloud/pairing", body);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const credential = typeof payload.credential === "string" ? payload.credential : `omb_pair_${randomBytes(12).toString("base64url")}`;
    const pairingLink = `${workspace.publicUrl}/pair#signin=${credential}`;
    return {
      status: response.status,
      body: { ...payload, pairingLink, ...(workspace.role === "team" && input.member ? { scopes: teamRoleScopes(input.member.role) } : {}) },
      workspaceId: workspace.id,
    };
  }

  async function destroyWorkspace(id: string): Promise<{ destroyed: true; appName: string }> {
    const workspace = await config.store.get(id);
    if (!workspace) throw Object.assign(new Error("not_found"), { status: 404 });
    await config.fly.destroyApp(workspace.appName);
    await config.store.delete(workspace.id);
    return { destroyed: true, appName: workspace.appName };
  }

  return {
    createWorkspace,
    workspaceHealth,
    workspacePower,
    workspaceSleep,
    workspaceWake,
    workspacePairing,
    destroyWorkspace,
    store: config.store,
    fly: config.fly,
  };
}

export type AdminServices = ReturnType<typeof createAdminServices>;
