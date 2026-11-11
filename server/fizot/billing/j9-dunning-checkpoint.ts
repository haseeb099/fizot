/**
 * Authenticated Test Clock dunning checkpoints. Resume reconciles these against
 * live Stripe state and never repeats an advance once frozen_time has moved.
 */
export const J9_DUNNING_PHASES = [
  "baseline",
  "fail_pm_set",
  "failure_advance_committed",
  "failure_advanced",
  "failure_confirmed",
  "recover_pm_set",
  "recovery_advance_committed",
  "recovery_advanced",
  "recovered",
] as const;

export type J9DunningPhase = (typeof J9_DUNNING_PHASES)[number];

export type J9DunningCheckpoint = {
  phase: J9DunningPhase;
  failTargetFrozenTime: number | null;
  recoverTargetFrozenTime: number | null;
  failureInvoiceId: string | null;
  failureEventId: string | null;
  recoveryInvoiceId: string | null;
  recoveryEventId: string | null;
};

export function emptyDunningCheckpoint(): J9DunningCheckpoint {
  return {
    phase: "baseline",
    failTargetFrozenTime: null,
    recoverTargetFrozenTime: null,
    failureInvoiceId: null,
    failureEventId: null,
    recoveryInvoiceId: null,
    recoveryEventId: null,
  };
}

export function isDunningPhase(value: unknown): value is J9DunningPhase {
  return typeof value === "string" && (J9_DUNNING_PHASES as readonly string[]).includes(value);
}

export function parseDunningCheckpoint(raw: unknown): J9DunningCheckpoint | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!isDunningPhase(obj.phase)) return null;
  const numOrNull = (value: unknown): number | null | undefined => {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return undefined;
  };
  const idOrNull = (value: unknown, prefix: string): string | null | undefined => {
    if (value == null) return null;
    if (typeof value === "string" && value.startsWith(prefix)) return value;
    return undefined;
  };
  const failTarget = numOrNull(obj.failTargetFrozenTime);
  const recoverTarget = numOrNull(obj.recoverTargetFrozenTime);
  const failureInvoiceId = idOrNull(obj.failureInvoiceId, "in_");
  const failureEventId = idOrNull(obj.failureEventId, "evt_");
  const recoveryInvoiceId = idOrNull(obj.recoveryInvoiceId, "in_");
  const recoveryEventId = idOrNull(obj.recoveryEventId, "evt_");
  if (
    failTarget === undefined
    || recoverTarget === undefined
    || failureInvoiceId === undefined
    || failureEventId === undefined
    || recoveryInvoiceId === undefined
    || recoveryEventId === undefined
  ) {
    return null;
  }
  return {
    phase: obj.phase,
    failTargetFrozenTime: failTarget,
    recoverTargetFrozenTime: recoverTarget,
    failureInvoiceId,
    failureEventId,
    recoveryInvoiceId,
    recoveryEventId,
  };
}

export function dunningCheckpointPayload(checkpoint: J9DunningCheckpoint): Record<string, unknown> {
  return {
    phase: checkpoint.phase,
    failTargetFrozenTime: checkpoint.failTargetFrozenTime,
    recoverTargetFrozenTime: checkpoint.recoverTargetFrozenTime,
    failureInvoiceId: checkpoint.failureInvoiceId,
    failureEventId: checkpoint.failureEventId,
    recoveryInvoiceId: checkpoint.recoveryInvoiceId,
    recoveryEventId: checkpoint.recoveryEventId,
  };
}
