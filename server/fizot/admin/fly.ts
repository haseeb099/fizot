/**
 * Fly Machines API surface used by Fizot Admin.
 * Daily tests use the fake. Live staging uses createFlyMachinesClient(FLY_API_TOKEN).
 */
import { assertMachineBudget, formatCostProjection, MAX_STAGING_MACHINES } from "./cost-guard.ts";

export type FlyMachineGuest = { cpu_kind: "shared"; cpus: number; memory_mb: number };

export type FlyCreateAppInput = {
  appName: string;
  org: string;
  network: string;
};

export type FlyCreateVolumeInput = {
  appName: string;
  name: string;
  region: string;
  sizeGb: number;
};

export type FlyCreateMachineInput = {
  appName: string;
  region: string;
  name: string;
  image: string;
  volumeId: string;
  env: Record<string, string>;
  guest: FlyMachineGuest;
  /** Always true for staging (Gate G0b). */
  autoDestroy?: boolean;
  minSecretsVersion?: number;
};

export type FlySetSecretsInput = {
  appName: string;
  secrets: Record<string, string>;
};

export type FlyApp = { id: string; name: string; network: string };
export type FlyVolume = { id: string; name: string; sizeGb: number };
export type FlyMachineEvent = {
  type?: string;
  status?: string;
  source?: string;
  timestamp?: number;
};
export type FlyMachine = {
  id: string;
  name: string;
  state: string;
  privateIp?: string;
  createdAt?: string;
  checks?: unknown;
  events?: FlyMachineEvent[];
};
export type FlySecretsResult = { version: number };
export type FlyAllocatedIps = { v4?: string; v6?: string; via: "machines" | "graphql" | "fake" };

export interface FlyClient {
  createApp(input: FlyCreateAppInput): Promise<FlyApp>;
  /** Shared IPv4 + IPv6 so https://<app>.fly.dev is reachable. */
  allocateIps(appName: string): Promise<FlyAllocatedIps>;
  createVolume(input: FlyCreateVolumeInput): Promise<FlyVolume>;
  setSecrets(input: FlySetSecretsInput): Promise<FlySecretsResult>;
  createMachine(input: FlyCreateMachineInput): Promise<FlyMachine>;
  destroyApp(appName: string): Promise<void>;
  listApps(org: string): Promise<Array<{ name: string; id: string }>>;
  listMachines(appName: string): Promise<FlyMachine[]>;
  getMachine(appName: string, machineId: string): Promise<FlyMachine>;
  listVolumes(appName: string): Promise<FlyVolume[]>;
  getApp(appName: string): Promise<{ name: string } | null>;
  countLiveStagingMachines(org: string, appPrefix?: string): Promise<number>;
}

export const FLY_HOME_GUEST: FlyMachineGuest = { cpu_kind: "shared", cpus: 1, memory_mb: 2048 };
export const FLY_HOME_VOLUME_GB = 10;
export const FLY_STAGING_APP_PREFIX = "fizot-cm-";
const MACHINES_API = "https://api.machines.dev";
const FLY_GRAPHQL = "https://api.fly.io/graphql";

type ApiFn = (method: string, path: string, body?: unknown) => Promise<any>;

function makeApi(token: string, fetchImpl: typeof fetch): ApiFn {
  return async (method, path, body) => {
    const response = await fetchImpl(`${MACHINES_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!response.ok) {
      const detail = typeof json?.error === "string" ? json.error : text.slice(0, 200);
      throw new Error(`Fly ${method} ${path} → ${response.status}: ${detail}`);
    }
    return json;
  };
}

function mapMachine(row: any): FlyMachine {
  const events = Array.isArray(row?.events)
    ? row.events.slice(0, 8).map((e: any) => ({
      type: e?.type ? String(e.type) : undefined,
      status: e?.status ? String(e.status) : undefined,
      source: e?.source ? String(e.source) : undefined,
      timestamp: typeof e?.timestamp === "number" ? e.timestamp : undefined,
    }))
    : undefined;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    state: String(row.state ?? ""),
    privateIp: row.private_ip ? String(row.private_ip) : undefined,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    checks: row.checks ?? undefined,
    events,
  };
}

async function allocateIpGraphql(
  token: string,
  fetchImpl: typeof fetch,
  appName: string,
  type: "shared_v4" | "v6",
): Promise<string | undefined> {
  const response = await fetchImpl(FLY_GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      query: `mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) {
          ipAddress { address type }
          app { sharedIpAddress }
        }
      }`,
      variables: { input: { appId: appName, type } },
    }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Fly GraphQL allocateIpAddress → ${response.status}: ${text.slice(0, 200)}`);
  }
  if (Array.isArray(json?.errors) && json.errors.length) {
    throw new Error(`Fly GraphQL allocateIpAddress errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }
  const node = json?.data?.allocateIpAddress;
  const address = node?.ipAddress?.address ?? (type === "shared_v4" ? node?.app?.sharedIpAddress : undefined);
  return address ? String(address) : undefined;
}

/** In-memory Fly. Never calls the network. */
export function createFakeFlyClient(): FlyClient & {
  apps: Map<string, FlyApp>;
  volumes: Map<string, FlyVolume>;
  machines: Map<string, FlyMachine>;
  secrets: Map<string, Record<string, string>>;
  ips: Map<string, FlyAllocatedIps>;
  calls: string[];
} {
  const apps = new Map<string, FlyApp>();
  const volumes = new Map<string, FlyVolume>();
  const machines = new Map<string, FlyMachine>();
  const secrets = new Map<string, Record<string, string>>();
  const ips = new Map<string, FlyAllocatedIps>();
  const calls: string[] = [];
  let seq = 0;
  let secretVersion = 0;
  return {
    apps,
    volumes,
    machines,
    secrets,
    ips,
    calls,
    async createApp(input) {
      calls.push(`createApp:${input.appName}`);
      if (apps.has(input.appName)) throw new Error(`fly app ${input.appName} exists`);
      const app = { id: `app_${++seq}`, name: input.appName, network: input.network };
      apps.set(input.appName, app);
      return app;
    },
    async allocateIps(appName) {
      calls.push(`allocateIps:${appName}`);
      if (!apps.has(appName)) throw new Error(`fly app ${appName} missing`);
      const allocated: FlyAllocatedIps = {
        v4: `66.241.${seq}.1`,
        v6: `2a09:8280:${seq}::1`,
        via: "fake",
      };
      ips.set(appName, allocated);
      return allocated;
    },
    async createVolume(input) {
      calls.push(`createVolume:${input.appName}:${input.name}`);
      if (!apps.has(input.appName)) throw new Error(`fly app ${input.appName} missing`);
      const volume = { id: `vol_${++seq}`, name: input.name, sizeGb: input.sizeGb };
      volumes.set(`${input.appName}/${input.name}`, volume);
      return volume;
    },
    async setSecrets(input) {
      calls.push(`setSecrets:${input.appName}`);
      if (!apps.has(input.appName)) throw new Error(`fly app ${input.appName} missing`);
      secrets.set(input.appName, { ...input.secrets });
      secretVersion += 1;
      return { version: secretVersion };
    },
    async createMachine(input) {
      calls.push(`createMachine:${input.appName}:${input.name}`);
      if (!apps.has(input.appName)) throw new Error(`fly app ${input.appName} missing`);
      const live = await this.countLiveStagingMachines("fake");
      const projection = assertMachineBudget(live, MAX_STAGING_MACHINES);
      console.log(formatCostProjection(projection));
      if (input.autoDestroy === false) {
        throw new Error("cost guard: auto_destroy must stay on for staging machines");
      }
      const machine: FlyMachine = {
        id: `mach_${++seq}`,
        name: input.name,
        state: "started",
        privateIp: `fdaa:0:0::${seq}`,
        createdAt: new Date().toISOString(),
        checks: { http: { status: "passing" } },
        events: [{ type: "start", status: "started", source: "fake", timestamp: Date.now() }],
      };
      machines.set(`${input.appName}/${input.name}`, machine);
      return machine;
    },
    async destroyApp(appName) {
      calls.push(`destroyApp:${appName}`);
      apps.delete(appName);
      secrets.delete(appName);
      ips.delete(appName);
      for (const key of Array.from(volumes.keys())) {
        if (key.startsWith(`${appName}/`)) volumes.delete(key);
      }
      for (const key of Array.from(machines.keys())) {
        if (!key.startsWith(`${appName}/`)) continue;
        const m = machines.get(key);
        if (m) machines.set(key, { ...m, state: "destroyed" });
      }
    },
    async listApps() {
      return [...apps.values()].map((a) => ({ name: a.name, id: a.id }));
    },
    async listMachines(appName) {
      return [...machines.entries()]
        .filter(([key, m]) => key.startsWith(`${appName}/`) && m.state !== "destroyed")
        .map(([, m]) => m);
    },
    async getMachine(appName, machineId) {
      calls.push(`getMachine:${appName}:${machineId}`);
      const found = [...machines.entries()].find(([key, m]) =>
        key.startsWith(`${appName}/`) && m.id === machineId && m.state !== "destroyed");
      if (!found) throw new Error(`fly machine ${machineId} missing`);
      return found[1];
    },
    async listVolumes(appName) {
      return [...volumes.entries()]
        .filter(([key]) => key.startsWith(`${appName}/`))
        .map(([, v]) => v);
    },
    async getApp(appName) {
      const app = apps.get(appName);
      return app ? { name: app.name } : null;
    },
    async countLiveStagingMachines(_org, appPrefix = FLY_STAGING_APP_PREFIX) {
      let n = 0;
      for (const [key, m] of machines) {
        if (m.state === "destroyed") continue;
        const appName = key.split("/")[0] ?? "";
        if (appName.startsWith(appPrefix)) n++;
      }
      return n;
    },
  };
}

export type FlyMachinesClientOptions = {
  token: string;
  org: string;
  fetchImpl?: typeof fetch;
  printCost?: boolean;
};

/** Real Fly Machines API. Token from FLY_API_TOKEN only — never log it. */
export function createFlyMachinesClient(options: FlyMachinesClientOptions): FlyClient {
  const token = options.token?.trim();
  if (!token) throw new Error("FLY_API_TOKEN is required for the real Fly client");
  const org = options.org?.trim();
  if (!org) throw new Error("FLY_ORG is required for the real Fly client");
  const fetchImpl = options.fetchImpl ?? fetch;
  const printCost = options.printCost !== false;
  const api = makeApi(token, fetchImpl);

  async function allocateOne(appName: string, type: "shared_v4" | "v6"): Promise<{ address?: string; via: "machines" | "graphql" }> {
    try {
      const json = await api("POST", `/v1/apps/${encodeURIComponent(appName)}/ip_assignments`, { type });
      const address = json?.ip
        ?? (type === "shared_v4" ? json?.ip_pair?.v4 : json?.ip_pair?.v6)
        ?? undefined;
      return { address: address ? String(address) : undefined, via: "machines" };
    } catch (machinesError) {
      try {
        const address = await allocateIpGraphql(token, fetchImpl, appName, type);
        return { address, via: "graphql" };
      } catch (graphqlError) {
        throw new Error(
          `allocate ${type} for ${appName} failed: machines=${machinesError instanceof Error ? machinesError.message : String(machinesError)}; graphql=${graphqlError instanceof Error ? graphqlError.message : String(graphqlError)}`,
        );
      }
    }
  }

  const client: FlyClient = {
    async createApp(input) {
      const json = await api("POST", "/v1/apps", {
        app_name: input.appName,
        org_slug: input.org,
        network: input.network,
      });
      return {
        id: String(json?.id ?? json?.app?.id ?? input.appName),
        name: input.appName,
        network: input.network,
      };
    },
    async allocateIps(appName) {
      const v4 = await allocateOne(appName, "shared_v4");
      const v6 = await allocateOne(appName, "v6");
      const via = v4.via === "graphql" || v6.via === "graphql" ? "graphql" : "machines";
      return { v4: v4.address, v6: v6.address, via };
    },
    async createVolume(input) {
      const json = await api("POST", `/v1/apps/${encodeURIComponent(input.appName)}/volumes`, {
        name: input.name,
        region: input.region,
        size_gb: input.sizeGb,
      });
      return {
        id: String(json.id),
        name: String(json.name ?? input.name),
        sizeGb: Number(json.size_gb ?? input.sizeGb),
      };
    },
    async setSecrets(input) {
      const json = await api("POST", `/v1/apps/${encodeURIComponent(input.appName)}/secrets`, {
        values: input.secrets,
      });
      return { version: Number(json?.version ?? json?.Version ?? 0) };
    },
    async createMachine(input) {
      const live = await client.countLiveStagingMachines(org, FLY_STAGING_APP_PREFIX);
      const projection = assertMachineBudget(live, MAX_STAGING_MACHINES);
      if (printCost) console.log(formatCostProjection(projection));
      if (input.autoDestroy === false) {
        throw new Error("cost guard: auto_destroy must stay on for staging machines");
      }

      const json = await api("POST", `/v1/apps/${encodeURIComponent(input.appName)}/machines`, {
        name: input.name,
        region: input.region,
        config: {
          image: input.image,
          env: input.env,
          guest: input.guest,
          auto_destroy: true,
          restart: { policy: "on-failure", max_retries: 3 },
          mounts: [{ volume: input.volumeId, path: "/data" }],
          services: [{
            protocol: "tcp",
            internal_port: 8080,
            ports: [
              { port: 443, handlers: ["tls", "http"] },
              { port: 80, handlers: ["http"] },
            ],
          }],
          checks: {
            http: {
              type: "http",
              port: 8080,
              method: "GET",
              path: "/api/health",
              interval: "15s",
              timeout: "5s",
              grace_period: "30s",
            },
          },
        },
        ...(input.minSecretsVersion ? { min_secrets_version: input.minSecretsVersion } : {}),
      });
      return mapMachine(json);
    },
    async destroyApp(appName) {
      await api("DELETE", `/v1/apps/${encodeURIComponent(appName)}?force=true`);
    },
    async listApps(orgSlug) {
      const json = await api("GET", `/v1/apps?org_slug=${encodeURIComponent(orgSlug)}`);
      const rows = Array.isArray(json) ? json : (json?.apps ?? []);
      return rows.map((row: any) => ({ name: String(row.name ?? row.app_name), id: String(row.id ?? row.name) }));
    },
    async listMachines(appName) {
      const json = await api("GET", `/v1/apps/${encodeURIComponent(appName)}/machines`);
      const rows = Array.isArray(json) ? json : [];
      return rows.map(mapMachine);
    },
    async getMachine(appName, machineId) {
      const json = await api("GET", `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`);
      return mapMachine(json);
    },
    async listVolumes(appName) {
      const json = await api("GET", `/v1/apps/${encodeURIComponent(appName)}/volumes`);
      const rows = Array.isArray(json) ? json : [];
      return rows.map((row: any) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        sizeGb: Number(row.size_gb ?? 0),
      }));
    },
    async getApp(appName) {
      try {
        const json = await api("GET", `/v1/apps/${encodeURIComponent(appName)}`);
        return { name: String(json?.name ?? json?.app_name ?? appName) };
      } catch (error) {
        if (String(error).includes("404")) return null;
        throw error;
      }
    },
    async countLiveStagingMachines(orgSlug, appPrefix = FLY_STAGING_APP_PREFIX) {
      const apps = await client.listApps(orgSlug);
      let n = 0;
      for (const app of apps) {
        if (!app.name.startsWith(appPrefix)) continue;
        const machines = await client.listMachines(app.name);
        n += machines.filter((m) => !["destroyed", "stopped"].includes(m.state)).length;
      }
      return n;
    },
  };
  return client;
}
