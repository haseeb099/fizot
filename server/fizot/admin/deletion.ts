/**
 * Workspace deletion job + legal receipt (P4.2 / FZ-25 / UK GDPR erasure).
 * Fail-loud, idempotent, verified. Receipt holds hashed workspace id only — no PII.
 */
import { createHash, randomUUID } from "node:crypto";
import type { InviteStore } from "./invites.ts";
import type { DeletionReceipt, WorkspaceStore } from "./store.ts";
import type { TenantStore } from "./tenant.ts";

export const DELETION_STEPS = [
  "machines",
  "volume",
  "app",
  "secrets",
  "workspace_rows",
  "verify",
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];

export const DELETION_ALERT_12H_MS = 12 * 60 * 60_000;
export const DELETION_FAIL_24H_MS = 24 * 60 * 60_000;
export const DELETION_HOURLY_ALERT_MS = 60 * 60_000;
export const DELETION_LEASE_TTL_MS = 5 * 60_000;

export function hashWorkspaceId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

/** Fly surface needed by the deletion runner (subset + granular destroy). */
export type DeletionFly = {
  listMachines(appName: string): Promise<Array<{ id: string; state: string }>>;
  listVolumes(appName: string): Promise<Array<{ id: string; name: string }>>;
  getApp(appName: string): Promise<{ name: string } | null>;
  destroyApp(appName: string): Promise<void>;
  /** Optional granular destroy — if absent, destroyApp covers the step. */
  destroyMachine?(appName: string, machineId: string): Promise<void>;
  destroyVolume?(appName: string, volumeId: string): Promise<void>;
  unsetSecrets?(appName: string): Promise<void>;
};

export type DeletionAlert = (input: {
  workspaceIdHash: string;
  kind: "12h" | "24h" | "hourly";
  message: string;
  receipt: DeletionReceipt;
}) => Promise<void> | void;

export type DeletionRunnerOptions = {
  store: WorkspaceStore;
  fly: DeletionFly;
  tenant?: TenantStore;
  invites?: InviteStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alert?: DeletionAlert;
  /** Max attempts per runOnce call before yielding. */
  maxAttempts?: number;
  backoffMs?: number;
  /** Stable id for this Admin instance (lease owner). */
  workerId?: string;
  leaseTtlMs?: number;
};

function isNotFound(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(msg) || /not found|missing|does not exist/i.test(msg);
}

export async function requestDeletion(
  store: WorkspaceStore,
  workspaceId: string,
  opts: { now?: () => number; reason?: string } = {},
): Promise<DeletionReceipt> {
  const now = opts.now ?? Date.now;
  const existing = await store.getDeletionReceipt(workspaceId);
  if (existing && (existing.status === "complete" || existing.status === "pending" || existing.status === "running")) {
    return existing;
  }
  const workspace = await store.get(workspaceId);
  if (!workspace && !existing) {
    throw Object.assign(new Error("not_found"), { status: 404 });
  }
  if (workspace && workspace.state !== "deleting" && workspace.state !== "deleted") {
    await store.transition(workspaceId, "deleting", opts.reason ?? "owner_delete", now);
  }
  const requestedAt = new Date(now()).toISOString();
  const receipt: DeletionReceipt = {
    workspaceId,
    workspaceIdHash: hashWorkspaceId(workspaceId),
    appName: workspace?.appName ?? existing?.appName ?? null,
    requestedAt: existing?.requestedAt ?? requestedAt,
    completedAt: null,
    failedAt: null,
    stepsDone: existing?.stepsDone ?? [],
    status: "pending",
    lastError: null,
    alertedAt12h: existing?.alertedAt12h ?? null,
    lastAlertAt: existing?.lastAlertAt ?? null,
    leaseOwner: existing?.leaseOwner ?? null,
    leaseUntil: existing?.leaseUntil ?? null,
  };
  return store.upsertDeletionReceipt(receipt);
}

export async function countWorkspaceRefs(
  store: WorkspaceStore,
  tenant: TenantStore | undefined,
  invites: InviteStore | undefined,
  workspaceId: string,
): Promise<{ remainingCount: number; details: string[] }> {
  const details: string[] = [];
  const row = await store.get(workspaceId);
  if (row) details.push("workspace_row");
  const transitions = await store.listTransitions(workspaceId);
  if (transitions.length) details.push(`transitions:${transitions.length}`);
  if (tenant) {
    const members = await tenant.listMembers(workspaceId);
    if (members.length) details.push(`memberships:${members.length}`);
  }
  if (invites) {
    const list = await invites.listInvites(workspaceId);
    if (list.length) details.push(`invites:${list.length}`);
  }
  return { remainingCount: details.length, details };
}

export function createDeletionRunner(options: DeletionRunnerOptions) {
  const store = options.store;
  const fly = options.fly;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = options.maxAttempts ?? 8;
  const backoffMs = options.backoffMs ?? 50;
  const workerId = options.workerId ?? randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DELETION_LEASE_TTL_MS;
  const alerts: string[] = [];
  let stepRuns = 0;

  async function maybeAlert(receipt: DeletionReceipt): Promise<DeletionReceipt> {
    const elapsed = now() - Date.parse(receipt.requestedAt);
    let next = { ...receipt };
    if (elapsed >= DELETION_ALERT_12H_MS && !next.alertedAt12h && next.status !== "complete") {
      const at = new Date(now()).toISOString();
      const message = `deletion_alert_12h hash=${next.workspaceIdHash} steps=${next.stepsDone.join(",")}`;
      alerts.push(message);
      await options.alert?.({ workspaceIdHash: next.workspaceIdHash, kind: "12h", message, receipt: next });
      next = { ...next, alertedAt12h: at, lastAlertAt: at };
    }
    if (elapsed >= DELETION_FAIL_24H_MS && next.status !== "complete") {
      const at = new Date(now()).toISOString();
      const firstFail = next.status !== "failed";
      if (firstFail) {
        next = { ...next, status: "failed", failedAt: at };
        const workspace = await store.get(next.workspaceId);
        if (workspace && workspace.state === "deleting") {
          await store.transition(next.workspaceId, "failed", "deletion_timeout_24h", now).catch(() => undefined);
        }
      }
      const sinceLast = next.lastAlertAt ? now() - Date.parse(next.lastAlertAt) : DELETION_HOURLY_ALERT_MS;
      if (firstFail || sinceLast >= DELETION_HOURLY_ALERT_MS) {
        const kind = firstFail ? "24h" as const : "hourly" as const;
        const message = kind === "24h"
          ? `deletion_alert_24h hash=${next.workspaceIdHash} status=failed`
          : `deletion_alert_hourly hash=${next.workspaceIdHash} status=failed`;
        alerts.push(message);
        await options.alert?.({
          workspaceIdHash: next.workspaceIdHash,
          kind,
          message,
          receipt: next,
        });
        next = { ...next, lastAlertAt: at, failedAt: next.failedAt ?? at };
      }
    }
    if (next !== receipt) await store.upsertDeletionReceipt(next);
    return next;
  }

  async function runStep(appName: string, step: DeletionStep, workspaceId: string): Promise<void> {
    stepRuns += 1;
    switch (step) {
      case "machines": {
        let machines: Array<{ id: string }> = [];
        try {
          machines = await fly.listMachines(appName);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        for (const m of machines) {
          if (fly.destroyMachine) {
            try {
              await fly.destroyMachine(appName, m.id);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          }
        }
        return;
      }
      case "volume": {
        let volumes: Array<{ id: string }> = [];
        try {
          volumes = await fly.listVolumes(appName);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        for (const v of volumes) {
          if (fly.destroyVolume) {
            await fly.destroyVolume(appName, v.id);
          }
        }
        return;
      }
      case "app": {
        try {
          await fly.destroyApp(appName);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return;
      }
      case "secrets": {
        if (fly.unsetSecrets) {
          try {
            await fly.unsetSecrets(appName);
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        return;
      }
      case "workspace_rows": {
        if (options.tenant) {
          const members = await options.tenant.listMembers(workspaceId);
          for (const m of members) {
            await options.tenant.deleteMembership(m.account.id, workspaceId);
          }
        }
        if (options.invites) {
          const list = await options.invites.listInvites(workspaceId);
          for (const inv of list) await options.invites.revokeInvite(inv.id);
        }
        await store.delete(workspaceId);
        return;
      }
      case "verify": {
        const app = await fly.getApp(appName);
        if (app) throw new Error("verify_failed:app_still_exists");
        try {
          const vols = await fly.listVolumes(appName);
          if (vols.length) throw new Error("verify_failed:volume_remains");
        } catch (error) {
          if (!isNotFound(error) && !(error instanceof Error && error.message.startsWith("verify_failed"))) {
            if (!isNotFound(error)) throw error;
          } else if (error instanceof Error && error.message.startsWith("verify_failed")) {
            throw error;
          }
        }
        await store.deleteTransitions(workspaceId);
        const refs = await countWorkspaceRefs(store, options.tenant, options.invites, workspaceId);
        if (refs.remainingCount !== 0) {
          throw new Error(`verify_failed:remainingCount=${refs.remainingCount}:${refs.details.join(",")}`);
        }
        return;
      }
      default:
        throw new Error(`unknown_step:${step}`);
    }
  }

  async function runOnce(workspaceId: string, opts: { skipLease?: boolean } = {}): Promise<DeletionReceipt> {
    let receipt = await store.getDeletionReceipt(workspaceId);
    if (!receipt) throw Object.assign(new Error("no_receipt"), { status: 404 });
    if (receipt.status === "complete") return receipt;

    if (!opts.skipLease) {
      const got = await store.tryAcquireDeletionLease(workspaceId, workerId, leaseTtlMs, now);
      if (!got) return receipt;
    }

    try {
      receipt = await maybeAlert(receipt);

      const workspace = await store.get(workspaceId);
      const appName = workspace?.appName
        ?? receipt.appName
        ?? `fizot-cm-${workspaceId.replace(/-/g, "").slice(0, 16)}`;

      receipt = {
        ...receipt,
        appName,
        status: receipt.status === "failed" ? "failed" : "running",
        lastError: null,
      };
      await store.upsertDeletionReceipt(receipt);

      for (const step of DELETION_STEPS) {
        if (receipt.stepsDone.includes(step)) continue;
        let attempts = 0;
        let stepDone = false;
        while (attempts < maxAttempts && !stepDone) {
          attempts++;
          try {
            await runStep(appName, step, workspaceId);
            receipt = {
              ...receipt,
              stepsDone: [...receipt.stepsDone, step],
              lastError: null,
            };
            await store.upsertDeletionReceipt(receipt);
            stepDone = true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            receipt = { ...receipt, lastError: message };
            await store.upsertDeletionReceipt(receipt);
            if (attempts >= maxAttempts) {
              receipt = await maybeAlert(receipt);
              return receipt;
            }
            await sleep(backoffMs * attempts);
          }
        }
      }

      const done = receipt;
      if (DELETION_STEPS.every((s) => done.stepsDone.includes(s))) {
        const completedAt = new Date(now()).toISOString();
        receipt = {
          ...done,
          status: "complete",
          completedAt,
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
        };
        await store.upsertDeletionReceipt(receipt);
        const ws = await store.get(workspaceId);
        if (ws && ws.state === "deleting") {
          await store.transition(workspaceId, "deleted", "deletion_verified", now).catch(() => undefined);
        }
      }
      return receipt;
    } finally {
      if (!opts.skipLease) {
        await store.releaseDeletionLease(workspaceId, workerId).catch(() => undefined);
      }
    }
  }

  async function processQueue(): Promise<DeletionReceipt[]> {
    const all = await store.listDeletionReceipts();
    const out: DeletionReceipt[] = [];
    for (const r of all) {
      if (r.status === "complete") continue;
      out.push(await runOnce(r.workspaceId));
    }
    return out;
  }

  return {
    workerId,
    requestDeletion: (workspaceId: string, reason?: string) =>
      requestDeletion(store, workspaceId, { now, reason }),
    runOnce,
    processQueue,
    alerts,
    hashWorkspaceId,
    get stepRuns() {
      return stepRuns;
    },
  };
}

export type DeletionRunner = ReturnType<typeof createDeletionRunner>;

/**
 * User-level erase: delete workspaces the account solely owns; leave other
 * workspaces intact (drop membership via memberLeft callback).
 */
export async function eraseAccount(input: {
  accountId: string;
  tenant: TenantStore;
  store: WorkspaceStore;
  runner: DeletionRunner;
  memberLeft?: (workspaceId: string, email: string) => Promise<void>;
  now?: () => number;
}): Promise<{
  deletedWorkspaceIds: string[];
  leftWorkspaceIds: string[];
  receipts: DeletionReceipt[];
}> {
  const rows = await input.tenant.listWorkspacesForAccount(input.accountId);
  const account = await input.tenant.getAccount(input.accountId);
  if (!account) throw Object.assign(new Error("not_found"), { status: 404 });

  const deletedWorkspaceIds: string[] = [];
  const leftWorkspaceIds: string[] = [];
  const receipts: DeletionReceipt[] = [];

  for (const row of rows) {
    if (row.membership.role === "owner") {
      const members = await input.tenant.listMembers(row.workspace.id);
      const soleOwner = members.filter((m) => m.membership.role === "owner").length === 1
        && members.every((m) => m.membership.role !== "owner" || m.account.id === input.accountId);
      if (soleOwner) {
        const receipt = await input.runner.requestDeletion(row.workspace.id, "account_erase");
        const done = await input.runner.runOnce(row.workspace.id);
        receipts.push(done.status === "complete" ? done : receipt);
        deletedWorkspaceIds.push(row.workspace.id);
        continue;
      }
    }
    await input.tenant.deleteMembership(input.accountId, row.workspace.id);
    if (row.workspace.role === "team" && input.memberLeft) {
      await input.memberLeft(row.workspace.id, account.email);
    }
    leftWorkspaceIds.push(row.workspace.id);
  }

  await input.tenant.revokeAllSessionsForAccount(input.accountId);
  if ("deleteAccount" in input.tenant && typeof (input.tenant as { deleteAccount?: (id: string) => Promise<void> }).deleteAccount === "function") {
    await (input.tenant as { deleteAccount: (id: string) => Promise<void> }).deleteAccount(input.accountId);
  }

  return { deletedWorkspaceIds, leftWorkspaceIds, receipts };
}
