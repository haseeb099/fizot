/**
 * J4 provider↔ledger reconciliation.
 * Compares provider-side cost evidence to Fizot-computed provider cost and
 * separately reports customer ledger charges (which include markup).
 * Read-only: never charges, refunds, or releases holds.
 */

import { RECONCILE_MAX_DRIFT, reconcileLedger } from "./reconcile.ts";

export type J4Verdict = "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE";

export type J4ProviderUsageRow = {
  /** Opaque provider billing id when the export supplies one. */
  providerRequestId: string | null;
  /** Fizot request_id when the export can be matched. */
  fizotRequestId: string | null;
  workspaceIdHash: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Integer micro-units of provider currency (usually micro-USD). */
  providerCostMicro: number;
  currency: "USD" | "GBP";
};

export type J4LedgerUsageRow = {
  requestId: string;
  workspaceIdHash: string;
  tier: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Absolute customer debit in micro-GBP (includes markup). */
  customerChargeMicroGbp: number;
  /**
   * Fizot-computed provider cost in the same micro-units as provider rows.
   * Null when the operator export omitted a convertible provider cost.
   */
  providerCostMicro: number | null;
  currency: "USD" | "GBP";
};

export type J4HoldRow = {
  requestId: string;
  workspaceIdHash: string;
  status: "reserved" | "dispatched" | "uncertain" | "quarantined";
  amountMicroGbp: number;
};

export type J4ReconcileInput = {
  period: string;
  provider: string;
  comparisonBasis:
    | "provider_cost_vs_fizot_provider_cost"
    | "customer_ledger_vs_provider_cost_disallowed";
  providerRows: readonly J4ProviderUsageRow[];
  ledgerRows: readonly J4LedgerUsageRow[];
  openHolds?: readonly J4HoldRow[];
  /** When false, missing evidence fails closed as INSUFFICIENT_EVIDENCE. */
  evidenceComplete: boolean;
  maxDrift?: number;
};

export type J4Match = {
  fizotRequestId: string;
  providerRequestId: string | null;
  providerCostMicro: number;
  fizotProviderCostMicro: number;
  customerChargeMicroGbp: number;
  drift: number;
};

export type J4ReconcileReport = {
  period: string;
  provider: string;
  comparisonBasis: J4ReconcileInput["comparisonBasis"];
  evidenceComplete: boolean;
  matched: J4Match[];
  unmatchedProvider: J4ProviderUsageRow[];
  unmatchedLedger: J4LedgerUsageRow[];
  duplicateProviderIds: string[];
  duplicateLedgerIds: string[];
  openHolds: J4HoldRow[];
  providerCostTotalMicro: number;
  fizotProviderCostTotalMicro: number;
  customerChargeTotalMicroGbp: number;
  drift: number;
  withinThreshold: boolean;
  maxDrift: number;
  verdict: J4Verdict;
  reasons: string[];
};

function assertNonNegInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function driftOf(a: number, b: number): number {
  const diff = Math.abs(a - b);
  if (b === 0) return a === 0 ? 0 : 1;
  return diff / Math.abs(b);
}

export function reconcileJ4(input: J4ReconcileInput): J4ReconcileReport {
  if (input.comparisonBasis === "customer_ledger_vs_provider_cost_disallowed") {
    throw new Error("customer_ledger_vs_provider_cost_disallowed");
  }
  const maxDrift = input.maxDrift ?? RECONCILE_MAX_DRIFT;
  const reasons: string[] = [];
  const openHolds = [...(input.openHolds ?? [])];

  for (const row of input.providerRows) {
    assertNonNegInt("inputTokens", row.inputTokens);
    assertNonNegInt("outputTokens", row.outputTokens);
    assertNonNegInt("providerCostMicro", row.providerCostMicro);
  }
  for (const row of input.ledgerRows) {
    assertNonNegInt("customerChargeMicroGbp", row.customerChargeMicroGbp);
    if (row.providerCostMicro != null) assertNonNegInt("providerCostMicro", row.providerCostMicro);
  }

  const providerByFizotId = new Map<string, J4ProviderUsageRow[]>();
  const providerBare: J4ProviderUsageRow[] = [];
  const seenProviderIds = new Map<string, number>();
  for (const row of input.providerRows) {
    if (row.providerRequestId) {
      seenProviderIds.set(row.providerRequestId, (seenProviderIds.get(row.providerRequestId) ?? 0) + 1);
    }
    if (row.fizotRequestId) {
      const list = providerByFizotId.get(row.fizotRequestId) ?? [];
      list.push(row);
      providerByFizotId.set(row.fizotRequestId, list);
    } else {
      providerBare.push(row);
    }
  }

  const seenLedgerIds = new Map<string, number>();
  for (const row of input.ledgerRows) {
    seenLedgerIds.set(row.requestId, (seenLedgerIds.get(row.requestId) ?? 0) + 1);
  }

  const duplicateProviderIds = [...seenProviderIds.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  const duplicateLedgerIds = [...seenLedgerIds.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  const matched: J4Match[] = [];
  const unmatchedLedger: J4LedgerUsageRow[] = [];
  const usedProvider = new Set<J4ProviderUsageRow>();

  for (const ledger of input.ledgerRows) {
    const candidates = providerByFizotId.get(ledger.requestId) ?? [];
    const providerRow = candidates.find((row) => !usedProvider.has(row));
    if (!providerRow || ledger.providerCostMicro == null) {
      unmatchedLedger.push(ledger);
      continue;
    }
    usedProvider.add(providerRow);
    matched.push({
      fizotRequestId: ledger.requestId,
      providerRequestId: providerRow.providerRequestId,
      providerCostMicro: providerRow.providerCostMicro,
      fizotProviderCostMicro: ledger.providerCostMicro,
      customerChargeMicroGbp: ledger.customerChargeMicroGbp,
      drift: driftOf(ledger.providerCostMicro, providerRow.providerCostMicro),
    });
  }

  const unmatchedProvider = [
    ...providerBare,
    ...[...providerByFizotId.values()].flat().filter((row) => !usedProvider.has(row)),
  ];

  const providerCostTotalMicro = matched.reduce((sum, row) => sum + row.providerCostMicro, 0);
  const fizotProviderCostTotalMicro = matched.reduce((sum, row) => sum + row.fizotProviderCostMicro, 0);
  const customerChargeTotalMicroGbp = input.ledgerRows
    .reduce((sum, row) => sum + row.customerChargeMicroGbp, 0);

  const totals = reconcileLedger({
    period: input.period,
    ledgerMicroGbp: fizotProviderCostTotalMicro,
    providerMicroGbp: providerCostTotalMicro,
  });
  const withinThreshold = totals.ok && totals.drift <= maxDrift;

  if (!input.evidenceComplete) reasons.push("provider_or_ledger_evidence_incomplete");
  if (input.providerRows.length === 0 && input.ledgerRows.length === 0) {
    reasons.push("no_rows_to_reconcile");
  }
  if (duplicateProviderIds.length > 0) reasons.push("duplicate_provider_request_ids");
  if (duplicateLedgerIds.length > 0) reasons.push("duplicate_ledger_request_ids");
  if (unmatchedProvider.length > 0) reasons.push("unmatched_provider_rows");
  if (unmatchedLedger.length > 0) reasons.push("unmatched_ledger_rows");
  if (openHolds.some((row) => row.status === "uncertain" || row.status === "quarantined")) {
    reasons.push("open_uncertain_or_quarantined_holds");
  }
  if (!withinThreshold) reasons.push("provider_cost_drift_over_threshold");

  let verdict: J4Verdict = "PASS";
  if (!input.evidenceComplete || (input.providerRows.length === 0 && input.ledgerRows.length === 0)) {
    verdict = "INSUFFICIENT_EVIDENCE";
  } else if (
    !withinThreshold
    || unmatchedProvider.length > 0
    || unmatchedLedger.length > 0
    || duplicateProviderIds.length > 0
    || duplicateLedgerIds.length > 0
  ) {
    verdict = "FAIL";
  } else if (openHolds.some((row) => row.status === "uncertain" || row.status === "quarantined")) {
    // Matched costs can pass while holds still need operator action.
    verdict = "FAIL";
  }

  return {
    period: input.period,
    provider: input.provider,
    comparisonBasis: input.comparisonBasis,
    evidenceComplete: input.evidenceComplete,
    matched,
    unmatchedProvider,
    unmatchedLedger,
    duplicateProviderIds,
    duplicateLedgerIds,
    openHolds,
    providerCostTotalMicro,
    fizotProviderCostTotalMicro,
    customerChargeTotalMicroGbp,
    drift: totals.drift,
    withinThreshold,
    maxDrift,
    verdict,
    reasons,
  };
}

export function formatJ4Report(report: J4ReconcileReport): string {
  return [
    `j4 period=${report.period} provider=${report.provider} verdict=${report.verdict}`,
    `basis=${report.comparisonBasis} evidenceComplete=${report.evidenceComplete}`,
    `providerCost=${report.providerCostTotalMicro} fizotProviderCost=${report.fizotProviderCostTotalMicro} drift=${report.drift.toFixed(6)} ok=${report.withinThreshold}`,
    `customerChargeMicroGbp=${report.customerChargeTotalMicroGbp}`,
    `matched=${report.matched.length} unmatchedProvider=${report.unmatchedProvider.length} unmatchedLedger=${report.unmatchedLedger.length}`,
    `holds=${report.openHolds.length} reasons=${report.reasons.join(",") || "none"}`,
  ].join("\n");
}
