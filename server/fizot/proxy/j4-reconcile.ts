/**
 * J4 provider↔ledger reconciliation.
 * Compares provider-side cost evidence to Fizot-computed provider cost and
 * separately reports customer ledger charges (which include markup).
 * Read-only: never charges, refunds, or releases holds.
 */

import { RECONCILE_MAX_DRIFT, reconcileLedger } from "./reconcile.ts";

export type J4Verdict = "PASS" | "FAIL" | "INSUFFICIENT_EVIDENCE";

export type J4Currency = "USD" | "GBP";

export type J4ProviderUsageRow = {
  /** Opaque provider billing id when the export supplies one. */
  providerRequestId: string | null;
  /** Fizot request_id when the export can be matched. Never invent this join. */
  fizotRequestId: string | null;
  workspaceIdHash: string | null;
  /** Provider-billed model id from the export. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Integer micro-units of provider currency (usually micro-USD). */
  providerCostMicro: number;
  currency: J4Currency;
};

export type J4LedgerUsageRow = {
  requestId: string;
  workspaceIdHash: string;
  tier: string | null;
  /** Internal Fizot model slug (may differ from provider-billed id). */
  model: string | null;
  /**
   * Provider-billed model expected for this ledger row.
   * Required for a dimension-valid match; null is missing identity, not equality.
   */
  providerModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Absolute customer debit in micro-GBP (includes markup). */
  customerChargeMicroGbp: number;
  /**
   * Fizot-computed provider cost in the same micro-units as provider rows.
   * Null when the operator export omitted a convertible provider cost.
   */
  providerCostMicro: number | null;
  currency: J4Currency;
};

export type J4HoldRow = {
  requestId: string;
  workspaceIdHash: string;
  status: "reserved" | "dispatched" | "uncertain" | "quarantined";
  amountMicroGbp: number;
};

/**
 * Structured evidence package. A bare `evidenceComplete: true` boolean is not
 * acceptance-grade and cannot produce an acceptance-eligible PASS.
 */
export type J4EvidencePackage = {
  /** synthetic_fixture exercises the tool only; never J4 acceptance. */
  evidenceClass: "synthetic_fixture" | "operator_export";
  periodStartUtc: string;
  periodEndUtc: string;
  providerExportSource: string;
  providerExportGeneratedAtUtc: string;
  /** Hashed/redacted billing-scope id — never a raw account secret. */
  providerBillingScopeHash: string;
  providerExportRecordCount: number;
  providerExportTotalBilledMicro: number;
  ledgerExportSource: string;
  ledgerExportGeneratedAtUtc: string;
  ledgerExportRecordCount: number;
  pricingVerificationStatus:
    | "verified"
    | "mismatched_unverified"
    | "placeholder_unverified"
    | "mixed";
  currency: J4Currency;
  conversionBasis: string;
  correlationMethod: "fizot_request_id_with_dimension_checks";
  knownCoverageGaps: readonly string[];
  operatorAttestation: {
    attestedBy: string;
    attestedAtUtc: string;
    statement: string;
  };
  /** Operator claims full-period coverage. Not independent verification. */
  operatorAttestsComplete: boolean;
};

export type J4EvidenceAssessment = {
  structurallyValid: boolean;
  operatorAttestedComplete: boolean;
  /** Always false when the tool only has operator-supplied assertions. */
  independentlyVerifiable: boolean;
  /** True only for operator_export packages that could support real J4 PASS. */
  acceptanceEligible: boolean;
  reasons: string[];
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
  /**
   * Legacy boolean. Alone it cannot produce an acceptance-eligible PASS.
   * Prefer `evidence`.
   */
  evidenceComplete?: boolean;
  evidence?: J4EvidencePackage | null;
  maxDrift?: number;
};

export type J4MatchMismatchReason =
  | "workspace_identity_unavailable"
  | "workspace_mismatch"
  | "provider_model_identity_unavailable"
  | "model_mismatch"
  | "currency_mismatch"
  | "token_identity_unavailable"
  | "token_count_mismatch"
  | "provider_cost_unavailable"
  | "provider_request_id_unavailable";

export type J4MatchAttempt = {
  fizotRequestId: string;
  providerRequestId: string | null;
  workspaceIdHash: string | null;
  providerModel: string | null;
  ledgerProviderModel: string | null;
  currency: J4Currency | null;
  reasons: J4MatchMismatchReason[];
};

export type J4Match = {
  fizotRequestId: string;
  providerRequestId: string | null;
  workspaceIdHash: string;
  providerModel: string;
  currency: J4Currency;
  inputTokens: number;
  outputTokens: number;
  providerCostMicro: number;
  fizotProviderCostMicro: number;
  customerChargeMicroGbp: number;
  /** Signed: fizot − provider (micro-units). */
  signedVarianceMicro: number;
  absoluteVarianceMicro: number;
  /** abs(signed) / provider, or 1 when provider is 0 and fizot ≠ 0. */
  drift: number;
  material: boolean;
};

export type J4ReconcileReport = {
  period: string;
  provider: string;
  comparisonBasis: J4ReconcileInput["comparisonBasis"];
  evidenceComplete: boolean;
  evidenceAssessment: J4EvidenceAssessment;
  matched: J4Match[];
  mismatched: J4MatchAttempt[];
  unmatchedProvider: J4ProviderUsageRow[];
  unmatchedLedger: J4LedgerUsageRow[];
  duplicateProviderIds: string[];
  duplicateLedgerIds: string[];
  openHolds: J4HoldRow[];
  providerCostTotalMicro: number;
  fizotProviderCostTotalMicro: number;
  customerChargeTotalMicroGbp: number;
  /** Aggregate signed variance (fizot − provider) over matched rows. */
  aggregateSignedVarianceMicro: number;
  /** Aggregate absolute variance over matched rows (offsetting cannot cancel). */
  aggregateAbsoluteVarianceMicro: number;
  maxPerRequestDrift: number;
  materialPerRequestCount: number;
  /** Sum of absolute per-request variances — financial exposure. */
  discrepancyExposureMicro: number;
  /** Documented J4 aggregate drift metric. */
  drift: number;
  withinThreshold: boolean;
  maxDrift: number;
  /** True when any matched row exceeds maxDrift (blocking exception). */
  materialPerRequestPolicyTriggered: boolean;
  verdict: J4Verdict;
  reasons: string[];
};

function assertNonNegInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertSafeInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}

function sumSafe(values: readonly number[], name: string): number {
  let total = 0n;
  for (const value of values) {
    assertSafeInt(name, value);
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${name} total overflows safe integer range`);
  }
  return Number(total);
}

function driftOf(fizot: number, provider: number): number {
  const diff = Math.abs(fizot - provider);
  if (provider === 0) return fizot === 0 ? 0 : 1;
  return diff / Math.abs(provider);
}

function isIsoUtc(value: string): boolean {
  if (!value || Number.isNaN(Date.parse(value))) return false;
  return true;
}

export function assessEvidence(input: {
  evidence?: J4EvidencePackage | null;
  evidenceComplete?: boolean;
  providerRows: readonly J4ProviderUsageRow[];
  ledgerRows: readonly J4LedgerUsageRow[];
}): J4EvidenceAssessment {
  const reasons: string[] = [];
  const evidence = input.evidence ?? null;

  if (!evidence) {
    reasons.push("evidence_package_missing");
    if (input.evidenceComplete === true) reasons.push("legacy_boolean_evidence_only");
    if (input.evidenceComplete !== true) reasons.push("provider_or_ledger_evidence_incomplete");
    return {
      structurallyValid: false,
      operatorAttestedComplete: false,
      independentlyVerifiable: false,
      acceptanceEligible: false,
      reasons,
    };
  }

  let structurallyValid = true;
  if (!isIsoUtc(evidence.periodStartUtc) || !isIsoUtc(evidence.periodEndUtc)) {
    structurallyValid = false;
    reasons.push("period_bounds_invalid");
  } else if (Date.parse(evidence.periodEndUtc) < Date.parse(evidence.periodStartUtc)) {
    structurallyValid = false;
    reasons.push("period_bounds_inverted");
  }
  if (!evidence.providerExportSource.trim()) {
    structurallyValid = false;
    reasons.push("provider_export_source_missing");
  }
  if (!isIsoUtc(evidence.providerExportGeneratedAtUtc)) {
    structurallyValid = false;
    reasons.push("provider_export_timestamp_invalid");
  }
  if (!evidence.providerBillingScopeHash.trim()) {
    structurallyValid = false;
    reasons.push("provider_billing_scope_hash_missing");
  }
  if (!evidence.ledgerExportSource.trim()) {
    structurallyValid = false;
    reasons.push("ledger_export_source_missing");
  }
  if (!isIsoUtc(evidence.ledgerExportGeneratedAtUtc)) {
    structurallyValid = false;
    reasons.push("ledger_export_timestamp_invalid");
  }
  if (!evidence.conversionBasis.trim()) {
    structurallyValid = false;
    reasons.push("conversion_basis_missing");
  }
  if (evidence.correlationMethod !== "fizot_request_id_with_dimension_checks") {
    structurallyValid = false;
    reasons.push("correlation_method_unsupported");
  }
  if (!evidence.operatorAttestation.attestedBy.trim()
    || !isIsoUtc(evidence.operatorAttestation.attestedAtUtc)
    || !evidence.operatorAttestation.statement.trim()) {
    structurallyValid = false;
    reasons.push("operator_attestation_incomplete");
  }

  assertNonNegInt("providerExportRecordCount", evidence.providerExportRecordCount);
  assertNonNegInt("ledgerExportRecordCount", evidence.ledgerExportRecordCount);
  assertNonNegInt("providerExportTotalBilledMicro", evidence.providerExportTotalBilledMicro);

  if (evidence.providerExportRecordCount !== input.providerRows.length) {
    structurallyValid = false;
    reasons.push("provider_export_record_count_mismatch");
  }
  if (evidence.ledgerExportRecordCount !== input.ledgerRows.length) {
    structurallyValid = false;
    reasons.push("ledger_export_record_count_mismatch");
  }

  const providerTotal = sumSafe(
    input.providerRows.map((row) => row.providerCostMicro),
    "providerExportTotalBilledMicro",
  );
  if (evidence.providerExportTotalBilledMicro !== providerTotal) {
    structurallyValid = false;
    reasons.push("provider_export_total_mismatch");
  }

  for (const row of input.providerRows) {
    if (row.currency !== evidence.currency) {
      structurallyValid = false;
      reasons.push("provider_currency_mismatch_vs_evidence");
      break;
    }
  }
  for (const row of input.ledgerRows) {
    if (row.currency !== evidence.currency) {
      structurallyValid = false;
      reasons.push("ledger_currency_mismatch_vs_evidence");
      break;
    }
  }

  if (evidence.knownCoverageGaps.length > 0) {
    reasons.push("known_coverage_gaps_declared");
  }

  if (evidence.pricingVerificationStatus !== "verified") {
    reasons.push("pricing_verification_not_verified");
  }

  const operatorAttestedComplete = evidence.operatorAttestsComplete === true
    && evidence.knownCoverageGaps.length === 0;
  if (!evidence.operatorAttestsComplete) reasons.push("operator_did_not_attest_complete");
  if (evidence.knownCoverageGaps.length > 0 && evidence.operatorAttestsComplete) {
    reasons.push("attestation_conflicts_with_coverage_gaps");
  }

  // This tool only sees operator-supplied exports; it cannot independently verify them.
  const independentlyVerifiable = false;
  reasons.push("independent_verification_unavailable");

  // Necessary conditions for a future acceptance-grade path; this tool alone
  // never sets acceptanceEligible because it cannot independently verify exports.
  const necessaryForAcceptance = evidence.evidenceClass === "operator_export"
    && structurallyValid
    && operatorAttestedComplete
    && evidence.pricingVerificationStatus === "verified";
  const acceptanceEligible = false;
  if (!necessaryForAcceptance && evidence.evidenceClass === "operator_export") {
    reasons.push("operator_export_not_acceptance_ready");
  }
  reasons.push("acceptance_requires_independent_verification");

  if (evidence.evidenceClass === "synthetic_fixture") {
    reasons.push("synthetic_fixture_not_j4_acceptance");
  }

  return {
    structurallyValid,
    operatorAttestedComplete,
    independentlyVerifiable,
    acceptanceEligible,
    reasons,
  };
}

function dimensionCheck(
  provider: J4ProviderUsageRow,
  ledger: J4LedgerUsageRow,
): J4MatchMismatchReason[] {
  const reasons: J4MatchMismatchReason[] = [];

  if (!provider.workspaceIdHash || !ledger.workspaceIdHash) {
    reasons.push("workspace_identity_unavailable");
  } else if (provider.workspaceIdHash !== ledger.workspaceIdHash) {
    reasons.push("workspace_mismatch");
  }

  if (!ledger.providerModel || !provider.model) {
    reasons.push("provider_model_identity_unavailable");
  } else if (ledger.providerModel !== provider.model) {
    reasons.push("model_mismatch");
  }

  if (provider.currency !== ledger.currency) {
    reasons.push("currency_mismatch");
  }

  if (ledger.inputTokens == null || ledger.outputTokens == null) {
    reasons.push("token_identity_unavailable");
  } else if (
    ledger.inputTokens !== provider.inputTokens
    || ledger.outputTokens !== provider.outputTokens
  ) {
    reasons.push("token_count_mismatch");
  }

  if (ledger.providerCostMicro == null) {
    reasons.push("provider_cost_unavailable");
  }

  if (!provider.providerRequestId) {
    reasons.push("provider_request_id_unavailable");
  }

  return reasons;
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
    if (row.inputTokens != null) assertNonNegInt("inputTokens", row.inputTokens);
    if (row.outputTokens != null) assertNonNegInt("outputTokens", row.outputTokens);
  }

  const evidenceAssessment = assessEvidence({
    evidence: input.evidence,
    evidenceComplete: input.evidenceComplete,
    providerRows: input.providerRows,
    ledgerRows: input.ledgerRows,
  });
  reasons.push(...evidenceAssessment.reasons);

  const providerByFizotId = new Map<string, J4ProviderUsageRow[]>();
  const providerBare: J4ProviderUsageRow[] = [];
  const seenProviderIds = new Map<string, number>();
  for (const row of input.providerRows) {
    if (row.providerRequestId) {
      seenProviderIds.set(
        row.providerRequestId,
        (seenProviderIds.get(row.providerRequestId) ?? 0) + 1,
      );
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
  const mismatched: J4MatchAttempt[] = [];
  const unmatchedLedger: J4LedgerUsageRow[] = [];
  const usedProvider = new Set<J4ProviderUsageRow>();

  for (const ledger of input.ledgerRows) {
    const candidates = providerByFizotId.get(ledger.requestId) ?? [];
    const providerRow = candidates.find((row) => !usedProvider.has(row));
    if (!providerRow) {
      unmatchedLedger.push(ledger);
      continue;
    }
    const dimReasons = dimensionCheck(providerRow, ledger);
    if (dimReasons.length > 0) {
      usedProvider.add(providerRow);
      mismatched.push({
        fizotRequestId: ledger.requestId,
        providerRequestId: providerRow.providerRequestId,
        workspaceIdHash: providerRow.workspaceIdHash ?? ledger.workspaceIdHash,
        providerModel: providerRow.model,
        ledgerProviderModel: ledger.providerModel,
        currency: providerRow.currency,
        reasons: dimReasons,
      });
      continue;
    }

    usedProvider.add(providerRow);
    const fizotCost = ledger.providerCostMicro as number;
    const signedVarianceMicro = fizotCost - providerRow.providerCostMicro;
    const absoluteVarianceMicro = Math.abs(signedVarianceMicro);
    const drift = driftOf(fizotCost, providerRow.providerCostMicro);
    matched.push({
      fizotRequestId: ledger.requestId,
      providerRequestId: providerRow.providerRequestId,
      workspaceIdHash: ledger.workspaceIdHash,
      providerModel: providerRow.model,
      currency: providerRow.currency,
      inputTokens: providerRow.inputTokens,
      outputTokens: providerRow.outputTokens,
      providerCostMicro: providerRow.providerCostMicro,
      fizotProviderCostMicro: fizotCost,
      customerChargeMicroGbp: ledger.customerChargeMicroGbp,
      signedVarianceMicro,
      absoluteVarianceMicro,
      drift,
      material: drift > maxDrift,
    });
  }

  const unmatchedProvider = [
    ...providerBare,
    ...[...providerByFizotId.values()].flat().filter((row) => !usedProvider.has(row)),
  ];

  const providerCostTotalMicro = sumSafe(
    matched.map((row) => row.providerCostMicro),
    "providerCostTotalMicro",
  );
  const fizotProviderCostTotalMicro = sumSafe(
    matched.map((row) => row.fizotProviderCostMicro),
    "fizotProviderCostTotalMicro",
  );
  const customerChargeTotalMicroGbp = sumSafe(
    input.ledgerRows.map((row) => row.customerChargeMicroGbp),
    "customerChargeTotalMicroGbp",
  );
  const aggregateSignedVarianceMicro = sumSafe(
    matched.map((row) => row.signedVarianceMicro),
    "aggregateSignedVarianceMicro",
  );
  const aggregateAbsoluteVarianceMicro = sumSafe(
    matched.map((row) => row.absoluteVarianceMicro),
    "aggregateAbsoluteVarianceMicro",
  );
  const discrepancyExposureMicro = aggregateAbsoluteVarianceMicro;
  const maxPerRequestDrift = matched.reduce((max, row) => Math.max(max, row.drift), 0);
  const materialPerRequestCount = matched.filter((row) => row.material).length;
  const materialPerRequestPolicyTriggered = materialPerRequestCount > 0;

  const totals = reconcileLedger({
    period: input.period,
    ledgerMicroGbp: fizotProviderCostTotalMicro,
    providerMicroGbp: providerCostTotalMicro,
  });
  const withinThreshold = totals.ok && totals.drift <= maxDrift;

  if (input.providerRows.length === 0 && input.ledgerRows.length === 0) {
    reasons.push("no_rows_to_reconcile");
  }
  if (duplicateProviderIds.length > 0) reasons.push("duplicate_provider_request_ids");
  if (duplicateLedgerIds.length > 0) reasons.push("duplicate_ledger_request_ids");
  if (unmatchedProvider.length > 0) reasons.push("unmatched_provider_rows");
  if (unmatchedLedger.length > 0) reasons.push("unmatched_ledger_rows");
  if (mismatched.length > 0) reasons.push("dimension_mismatched_rows");
  if (openHolds.some((row) => row.status === "uncertain" || row.status === "quarantined")) {
    reasons.push("open_uncertain_or_quarantined_holds");
  }
  if (!withinThreshold) reasons.push("provider_cost_drift_over_threshold");
  if (materialPerRequestPolicyTriggered) {
    reasons.push("material_per_request_discrepancies");
  }

  const currencies = new Set([
    ...input.providerRows.map((row) => row.currency),
    ...input.ledgerRows.map((row) => row.currency),
  ]);
  if (currencies.size > 1) reasons.push("mixed_currencies_in_input");

  const uniqueReasons = [...new Set(reasons)];

  const reconcileDirty = !withinThreshold
    || materialPerRequestPolicyTriggered
    || unmatchedProvider.length > 0
    || unmatchedLedger.length > 0
    || mismatched.length > 0
    || duplicateProviderIds.length > 0
    || duplicateLedgerIds.length > 0
    || currencies.size > 1
    || openHolds.some((row) => row.status === "uncertain" || row.status === "quarantined");

  const syntheticToolPass = input.evidence?.evidenceClass === "synthetic_fixture"
    && evidenceAssessment.structurallyValid
    && input.evidence.operatorAttestsComplete
    && input.evidence.knownCoverageGaps.length === 0
    && input.providerRows.length + input.ledgerRows.length > 0;

  // Dirty reconciliation is FAIL (actionable). Clean but non-acceptance evidence
  // (boolean-only, operator_export without independent verification, incomplete
  // package) is INSUFFICIENT_EVIDENCE. Only synthetic_fixture tool integrity can PASS.
  let verdict: J4Verdict;
  if (!input.evidence || !evidenceAssessment.structurallyValid) {
    // Incomplete/invalid evidence always fails closed as insufficient.
    verdict = "INSUFFICIENT_EVIDENCE";
  } else if (reconcileDirty) {
    verdict = "FAIL";
  } else if (syntheticToolPass) {
    verdict = "PASS";
  } else {
    verdict = "INSUFFICIENT_EVIDENCE";
  }

  return {
    period: input.period,
    provider: input.provider,
    comparisonBasis: input.comparisonBasis,
    evidenceComplete: Boolean(
      input.evidence
      && evidenceAssessment.structurallyValid
      && evidenceAssessment.operatorAttestedComplete,
    ),
    evidenceAssessment,
    matched,
    mismatched,
    unmatchedProvider,
    unmatchedLedger,
    duplicateProviderIds,
    duplicateLedgerIds,
    openHolds,
    providerCostTotalMicro,
    fizotProviderCostTotalMicro,
    customerChargeTotalMicroGbp,
    aggregateSignedVarianceMicro,
    aggregateAbsoluteVarianceMicro,
    maxPerRequestDrift,
    materialPerRequestCount,
    discrepancyExposureMicro,
    drift: totals.drift,
    withinThreshold,
    maxDrift,
    materialPerRequestPolicyTriggered,
    verdict,
    reasons: uniqueReasons,
  };
}

export function formatJ4Report(report: J4ReconcileReport): string {
  return [
    `j4 period=${report.period} provider=${report.provider} verdict=${report.verdict}`,
    `basis=${report.comparisonBasis} evidenceComplete=${report.evidenceComplete} acceptanceEligible=${report.evidenceAssessment.acceptanceEligible}`,
    `providerCost=${report.providerCostTotalMicro} fizotProviderCost=${report.fizotProviderCostTotalMicro} drift=${report.drift.toFixed(6)} ok=${report.withinThreshold}`,
    `signedVar=${report.aggregateSignedVarianceMicro} absVar=${report.aggregateAbsoluteVarianceMicro} maxReqDrift=${report.maxPerRequestDrift.toFixed(6)} materialReqs=${report.materialPerRequestCount} exposure=${report.discrepancyExposureMicro}`,
    `customerChargeMicroGbp=${report.customerChargeTotalMicroGbp}`,
    `matched=${report.matched.length} mismatched=${report.mismatched.length} unmatchedProvider=${report.unmatchedProvider.length} unmatchedLedger=${report.unmatchedLedger.length}`,
    `holds=${report.openHolds.length} reasons=${report.reasons.join(",") || "none"}`,
  ].join("\n");
}

/** Helper for tests and fixtures: minimal structurally valid synthetic evidence. */
export function syntheticEvidence(
  overrides: Partial<J4EvidencePackage> & {
    providerExportRecordCount: number;
    ledgerExportRecordCount: number;
    providerExportTotalBilledMicro: number;
  },
): J4EvidencePackage {
  return {
    evidenceClass: "synthetic_fixture",
    periodStartUtc: "2026-11-01T00:00:00.000Z",
    periodEndUtc: "2026-11-30T23:59:59.000Z",
    providerExportSource: "synthetic-fixture",
    providerExportGeneratedAtUtc: "2026-11-19T00:00:00.000Z",
    providerBillingScopeHash: "scope-synthetic",
    ledgerExportSource: "synthetic-fixture",
    ledgerExportGeneratedAtUtc: "2026-11-19T00:00:00.000Z",
    pricingVerificationStatus: "mismatched_unverified",
    currency: "USD",
    conversionBasis: "none_usd",
    correlationMethod: "fizot_request_id_with_dimension_checks",
    knownCoverageGaps: [],
    operatorAttestation: {
      attestedBy: "synthetic-test",
      attestedAtUtc: "2026-11-19T00:00:00.000Z",
      statement: "Synthetic fixture for tool integrity only; not J4 acceptance.",
    },
    operatorAttestsComplete: true,
    ...overrides,
  };
}
