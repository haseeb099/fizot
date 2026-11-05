import { createServer, type Server } from "node:http";
import { assertAlertChannelsForProduction, resolveDeletionAlert } from "./alerts.ts";
import { FakeAuthProvider, UnconfiguredAuthProvider, type AuthProvider } from "./auth.ts";
import type { DeletionAlert } from "./deletion.ts";
import {
  createDeletionWorker,
  shouldStartDeletionWorker,
  type DeletionWorker,
} from "./deletion-worker.ts";
import {
  createFakeFlyClient,
  createFlyMachinesClient,
  resolveFlyOrg,
  type FlyClient,
} from "./fly.ts";
import { createMemoryNonceStore, type NonceStore } from "./nonce-store.ts";
import {
  createMemoryInviteStore,
  createPostgresInviteStore,
  type InviteStore,
} from "./invites.ts";
import { createAdminHandler } from "./routes.ts";
import { createMemoryWorkspaceStore, createPostgresWorkspaceStore, type WorkspaceStore } from "./store.ts";
import {
  createMemoryTenantStore,
  createPostgresTenantStore,
  type TenantStore,
} from "./tenant.ts";
import { createMemoryCreditStore, createPostgresCreditStore, type CreditStore } from "../proxy/credit-store.ts";
import { TokenStore } from "../proxy/tokens.ts";
import { createAdminServices, type AdminConfig } from "./workspaces.ts";

export type { FlyClient, NonceStore, WorkspaceStore, AdminConfig, AuthProvider, TenantStore, InviteStore };

export {
  createFakeFlyClient,
  createFlyMachinesClient,
  createMemoryNonceStore,
  createMemoryWorkspaceStore,
  createPostgresWorkspaceStore,
  createMemoryTenantStore,
  createPostgresTenantStore,
  createAdminServices,
  FakeAuthProvider,
  UnconfiguredAuthProvider,
  adminRequestSignature,
  signAdminRequest,
  verifyAdminRequest,
  mintNonce,
  mintBootstrapSecret,
  planFlags,
  redactForLog,
  safeLogLine,
  projectDailyCost,
  formatCostProjection,
  assertMachineBudget,
  CostGuardError,
  MAX_STAGING_MACHINES,
  MAX_PROBE_MACHINE_SECONDS,
  FLY_STAGING_APP_PREFIX,
  DEFAULT_FLY_ORG,
  resolveFlyOrg,
  describeFetchError,
} from "./public.ts";

export type CreateAdminServerOptions = {
  adminUrl?: string;
  flyOrg?: string;
  flyRegion?: string;
  machineImage?: string;
  fly?: FlyClient;
  store?: WorkspaceStore;
  tenant?: TenantStore;
  invites?: InviteStore;
  auth?: AuthProvider;
  nonces?: NonceStore;
  machineFetch?: typeof fetch;
  port?: number;
  cookieSecure?: boolean;
  allowFakeSignIn?: boolean;
  /** Override deletion alert (tests inject a spy / fake HTTP). */
  deletionAlert?: DeletionAlert;
  /** Start background deletion worker (default: off in NODE_ENV=test). */
  enableDeletionWorker?: boolean;
  deletionWorkerIntervalMs?: number;
  deletionWorkerId?: string;
  alertFetch?: typeof fetch;
  now?: () => number;
  credit?: CreditStore;
  proxyTokens?: TokenStore;
  serviceSecret?: string | null;
};

export function isProductionAdminEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.FIZOT_ENV === "production";
}

export function resolveAdminAuth(options: {
  auth?: AuthProvider;
  nodeEnv?: string;
}): { auth: AuthProvider; allowFakeSignIn: boolean } {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const isTest = nodeEnv === "test";
  if (options.auth) {
    const allowFakeSignIn = options.auth instanceof FakeAuthProvider;
    return { auth: options.auth, allowFakeSignIn };
  }
  if (isTest) {
    return { auth: new FakeAuthProvider(), allowFakeSignIn: true };
  }
  return { auth: new UnconfiguredAuthProvider(), allowFakeSignIn: false };
}

export async function createAdminServer(options: CreateAdminServerOptions = {}): Promise<{
  server: Server;
  url: string;
  services: ReturnType<typeof createAdminServices>;
  tenant: TenantStore;
  invites: InviteStore;
  auth: AuthProvider;
  deletionWorker: DeletionWorker | null;
  credit: CreditStore;
  proxyTokens: TokenStore;
  close(): Promise<void>;
}> {
  assertAlertChannelsForProduction();
  const databaseUrl = process.env.ADMIN_DATABASE_URL?.trim();
  if (!options.store && !databaseUrl && isProductionAdminEnv()) {
    throw new Error("ADMIN_DATABASE_URL is required when NODE_ENV or FIZOT_ENV is production");
  }

  const store = options.store
    ?? (databaseUrl
      ? await createPostgresWorkspaceStore(databaseUrl)
      : createMemoryWorkspaceStore());
  const tenant = options.tenant
    ?? (databaseUrl
      ? await createPostgresTenantStore(databaseUrl, store)
      : createMemoryTenantStore(store));
  const invites = options.invites
    ?? (databaseUrl
      ? await createPostgresInviteStore(databaseUrl)
      : createMemoryInviteStore());
  const ownCredit = !options.credit && Boolean(databaseUrl);
  const credit = options.credit
    ?? (databaseUrl ? await createPostgresCreditStore(databaseUrl) : createMemoryCreditStore());
  const proxyTokens = options.proxyTokens ?? new TokenStore();
  const serviceSecret = options.serviceSecret === undefined
    ? (process.env.FIZOT_ADMIN_SERVICE_SECRET?.trim() || null)
    : options.serviceSecret;

  const resolved = resolveAdminAuth({ auth: options.auth });
  const auth = resolved.auth;
  const allowFakeSignIn = options.allowFakeSignIn ?? resolved.allowFakeSignIn;
  const cookieSecure = options.cookieSecure ?? true;

  const flyOrg = resolveFlyOrg(options.flyOrg);
  const token = process.env.FLY_API_TOKEN?.trim();
  const fly = options.fly
    ?? (token
      ? createFlyMachinesClient({ token, org: flyOrg })
      : createFakeFlyClient());
  const deletionAlert = options.deletionAlert
    ?? resolveDeletionAlert({ fetchImpl: options.alertFetch, now: options.now });
  const services = createAdminServices({
    adminUrl: options.adminUrl ?? process.env.FIZOT_ADMIN_URL ?? "https://admin.example.invalid",
    flyOrg,
    flyRegion: options.flyRegion ?? process.env.FLY_REGION ?? "lhr",
    machineImage: options.machineImage ?? process.env.FIZOT_MACHINE_IMAGE ?? "registry.fly.io/fizot-home:latest",
    fly,
    store,
    nonces: options.nonces ?? createMemoryNonceStore(),
    machineFetch: options.machineFetch,
    tenant,
    invites,
    deletionAlert,
    deletionWorkerId: options.deletionWorkerId,
    alertFetch: options.alertFetch,
    now: options.now,
  });
  const handler = createAdminHandler({
    services,
    tenant,
    invites,
    auth,
    cookieSecure,
    allowFakeSignIn,
    credit,
    proxyTokens,
    serviceSecret,
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("admin server has no port");
  const url = `http://127.0.0.1:${address.port}`;

  const startWorker = shouldStartDeletionWorker({ enabled: options.enableDeletionWorker });
  const deletionWorker = startWorker
    ? createDeletionWorker({
      runner: services.deletionRunner,
      intervalMs: options.deletionWorkerIntervalMs,
      enabled: true,
    })
    : null;

  return {
    server,
    url,
    services,
    tenant,
    invites,
    auth,
    deletionWorker,
    credit,
    proxyTokens,
    async close() {
      deletionWorker?.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (ownCredit) await credit.close();
      if (store && "close" in store && typeof store.close === "function") await store.close();
      if (tenant && "close" in tenant && typeof tenant.close === "function") await (tenant as { close(): Promise<void> }).close();
      if (invites && "close" in invites && typeof invites.close === "function") await (invites as { close(): Promise<void> }).close();
    },
  };
}
