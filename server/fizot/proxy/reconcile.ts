export type LedgerReconcileInput = {
  period: string;
  ledgerMicroGbp: number;
  providerMicroGbp: number;
};

export type LedgerReconcileResult = {
  period: string;
  ledgerMicroGbp: number;
  providerMicroGbp: number;
  /** abs(ledger - provider) / provider, or 0 when both are 0. */
  drift: number;
  ok: boolean;
};

/** Acceptance bar: drift at most 1%. */
export const RECONCILE_MAX_DRIFT = 0.01;

export function reconcileLedger(input: LedgerReconcileInput): LedgerReconcileResult {
  if (!Number.isInteger(input.ledgerMicroGbp) || !Number.isInteger(input.providerMicroGbp)) {
    throw new Error("reconcile totals must be integers");
  }
  const diff = Math.abs(input.ledgerMicroGbp - input.providerMicroGbp);
  const drift = input.providerMicroGbp === 0
    ? (input.ledgerMicroGbp === 0 ? 0 : 1)
    : diff / Math.abs(input.providerMicroGbp);
  return {
    period: input.period,
    ledgerMicroGbp: input.ledgerMicroGbp,
    providerMicroGbp: input.providerMicroGbp,
    drift,
    ok: drift <= RECONCILE_MAX_DRIFT,
  };
}

export function formatReconcile(result: LedgerReconcileResult): string {
  return `reconcile period=${result.period} ledger=${result.ledgerMicroGbp} provider=${result.providerMicroGbp} drift=${result.drift.toFixed(6)} ok=${result.ok}`;
}
