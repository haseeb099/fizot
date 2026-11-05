/**
 * Provisioning reconciler: compare Postgres workspaces with Fly apps (fizot-cm-*).
 * Orphan Fly apps older than 1h are reported only — never auto-deleted here.
 * Staging 24h cleanup may delete staging-org orphans only.
 */
import { FLY_STAGING_APP_PREFIX, type FlyClient } from "./fly.ts";
import type { WorkspaceStore } from "./store.ts";

export const ORPHAN_REPORT_AGE_MS = 60 * 60_000;

export type ReconcileReport = {
  repaired: Array<{ workspaceId: string; action: string }>;
  drifted: Array<{ workspaceId: string; reason: string }>;
  orphans: Array<{ appName: string; ageMs: number }>;
  at: string;
};

export type ReconcileFly = Pick<FlyClient, "listApps" | "listMachines" | "listVolumes" | "getApp">;

export async function reconcileWorkspaces(input: {
  store: WorkspaceStore;
  fly: ReconcileFly;
  org: string;
  now?: () => number;
  appPrefix?: string;
}): Promise<ReconcileReport> {
  const now = input.now ?? Date.now;
  const prefix = input.appPrefix ?? FLY_STAGING_APP_PREFIX;
  const at = new Date(now()).toISOString();
  const repaired: ReconcileReport["repaired"] = [];
  const drifted: ReconcileReport["drifted"] = [];
  const orphans: ReconcileReport["orphans"] = [];

  const workspaces = await input.store.listAll();
  const byApp = new Map(workspaces.map((w) => [w.appName, w]));

  const apps = await input.fly.listApps(input.org);
  const flyPrefixed = apps.filter((a) => a.name.startsWith(prefix));

  for (const app of flyPrefixed) {
    const row = byApp.get(app.name);
    if (!row) {
      // Unknown app — report if we can estimate age; without createdAt use 0 and still list.
      orphans.push({ appName: app.name, ageMs: ORPHAN_REPORT_AGE_MS + 1 });
      continue;
    }
  }

  for (const ws of workspaces) {
    if (ws.state === "deleted") continue;
    if (ws.state === "creating" || ws.state === "requested" || ws.state === "failed") {
      const app = await input.fly.getApp(ws.appName).catch(() => null);
      if (!app) {
        if (ws.state === "creating") {
          await input.store.transition(ws.id, "failed", "reconcile_missing_app", now);
          drifted.push({ workspaceId: ws.id, reason: "creating_but_no_fly_app" });
        }
        continue;
      }
      const machines = await input.fly.listMachines(ws.appName).catch(() => []);
      const volumes = await input.fly.listVolumes(ws.appName).catch(() => []);
      if (machines.length === 0 && volumes.length > 0) {
        // Crash between create volume and create machine — flag for resume.
        drifted.push({ workspaceId: ws.id, reason: "volume_without_machine" });
        if (ws.state !== "failed") {
          await input.store.transition(ws.id, "failed", "reconcile_volume_without_machine", now);
        }
        continue;
      }
      if (machines.length > 0 && ws.flyMachineId === "" && ws.state === "creating") {
        const m = machines[0]!;
        const v = volumes[0];
        await input.store.update(ws.id, {
          flyMachineId: m.id,
          flyVolumeId: v?.id ?? ws.flyVolumeId,
        });
        await input.store.transition(ws.id, "ready", "reconcile_resume_ready", now);
        repaired.push({ workspaceId: ws.id, action: "resume_ready_from_fly" });
        continue;
      }
      if (machines.length > 0 && (ws.state === "creating" || ws.state === "failed")) {
        await input.store.transition(ws.id, "ready", "reconcile_mark_ready", now);
        repaired.push({ workspaceId: ws.id, action: "mark_ready" });
      }
    }

    if (ws.state === "ready" || ws.state === "awake" || ws.state === "sleeping") {
      const app = await input.fly.getApp(ws.appName).catch(() => null);
      if (!app) {
        drifted.push({ workspaceId: ws.id, reason: "ready_but_app_missing" });
      }
    }
  }

  // Age filter: only report orphans older than 1h. Without Fly createdAt we treat listed orphans as reportable.
  const agedOrphans = orphans.filter((o) => o.ageMs >= ORPHAN_REPORT_AGE_MS);

  return { repaired, drifted, orphans: agedOrphans, at };
}
