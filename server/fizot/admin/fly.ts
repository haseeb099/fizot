/** Fly Machines API surface used by Fizot Admin. Daily tests use the fake only. */

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
};

export type FlySetSecretsInput = {
  appName: string;
  secrets: Record<string, string>;
};

export type FlyApp = { id: string; name: string; network: string };
export type FlyVolume = { id: string; name: string; sizeGb: number };
export type FlyMachine = { id: string; name: string; state: string; privateIp?: string };

export interface FlyClient {
  createApp(input: FlyCreateAppInput): Promise<FlyApp>;
  createVolume(input: FlyCreateVolumeInput): Promise<FlyVolume>;
  setSecrets(input: FlySetSecretsInput): Promise<void>;
  createMachine(input: FlyCreateMachineInput): Promise<FlyMachine>;
}

/** In-memory Fly. Never calls the network. */
export function createFakeFlyClient(): FlyClient & {
  apps: Map<string, FlyApp>;
  volumes: Map<string, FlyVolume>;
  machines: Map<string, FlyMachine>;
  secrets: Map<string, Record<string, string>>;
  calls: string[];
} {
  const apps = new Map<string, FlyApp>();
  const volumes = new Map<string, FlyVolume>();
  const machines = new Map<string, FlyMachine>();
  const secrets = new Map<string, Record<string, string>>();
  const calls: string[] = [];
  let seq = 0;
  return {
    apps,
    volumes,
    machines,
    secrets,
    calls,
    async createApp(input) {
      calls.push(`createApp:${input.appName}`);
      if (apps.has(input.appName)) throw new Error(`fly app ${input.appName} exists`);
      const app = { id: `app_${++seq}`, name: input.appName, network: input.network };
      apps.set(input.appName, app);
      return app;
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
    },
    async createMachine(input) {
      calls.push(`createMachine:${input.appName}:${input.name}`);
      if (!apps.has(input.appName)) throw new Error(`fly app ${input.appName} missing`);
      const machine = { id: `mach_${++seq}`, name: input.name, state: "started", privateIp: `fdaa:0:0::${seq}` };
      machines.set(`${input.appName}/${input.name}`, machine);
      return machine;
    },
  };
}

export const FLY_HOME_GUEST: FlyMachineGuest = { cpu_kind: "shared", cpus: 1, memory_mb: 2048 };
export const FLY_HOME_VOLUME_GB = 10;
