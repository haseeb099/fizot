import { createServer, type Server } from "node:http";
import { createFakeFlyClient, type FlyClient } from "./fly.ts";
import { createMemoryNonceStore, type NonceStore } from "./nonce-store.ts";
import { createAdminHandler } from "./routes.ts";
import { createMemoryWorkspaceStore, createPostgresWorkspaceStore, type WorkspaceStore } from "./store.ts";
import { createAdminServices, type AdminConfig } from "./workspaces.ts";

export type { FlyClient, NonceStore, WorkspaceStore, AdminConfig };

export {
  createFakeFlyClient,
  createMemoryNonceStore,
  createMemoryWorkspaceStore,
  createPostgresWorkspaceStore,
  createAdminServices,
  adminRequestSignature,
  signAdminRequest,
  verifyAdminRequest,
  planFlags,
  redactForLog,
  safeLogLine,
} from "./public.ts";

export type CreateAdminServerOptions = {
  adminUrl?: string;
  flyOrg?: string;
  flyRegion?: string;
  machineImage?: string;
  fly?: FlyClient;
  store?: WorkspaceStore;
  nonces?: NonceStore;
  machineFetch?: typeof fetch;
  port?: number;
};

export async function createAdminServer(options: CreateAdminServerOptions = {}): Promise<{
  server: Server;
  url: string;
  services: ReturnType<typeof createAdminServices>;
  close(): Promise<void>;
}> {
  const store = options.store
    ?? (process.env.ADMIN_DATABASE_URL
      ? await createPostgresWorkspaceStore(process.env.ADMIN_DATABASE_URL)
      : createMemoryWorkspaceStore());
  const services = createAdminServices({
    adminUrl: options.adminUrl ?? process.env.FIZOT_ADMIN_URL ?? "https://admin.example.invalid",
    flyOrg: options.flyOrg ?? process.env.FLY_ORG ?? "fizot-staging",
    flyRegion: options.flyRegion ?? process.env.FLY_REGION ?? "lhr",
    machineImage: options.machineImage ?? process.env.FIZOT_MACHINE_IMAGE ?? "registry.fly.io/fizot-home:latest",
    fly: options.fly ?? createFakeFlyClient(),
    store,
    nonces: options.nonces ?? createMemoryNonceStore(),
    machineFetch: options.machineFetch,
  });
  const handler = createAdminHandler(services);
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
  return {
    server,
    url,
    services,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (store && "close" in store && typeof store.close === "function") await store.close();
    },
  };
}
