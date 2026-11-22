import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RECONCILE_MAX_DRIFT } from "../../../server/fizot/proxy/reconcile.ts";
import {
  formatJ4Report,
  reconcileJ4,
  resolveMaxDrift,
  syntheticEvidence,
  type J4LedgerUsageRow,
  type J4ProviderUsageRow,
  type J4ReconcileInput,
} from "../../../server/fizot/proxy/j4-reconcile.ts";

const exact = fileURLToPath(new URL("./fixtures/j4-exact.json", import.meta.url));
const missing = fileURLToPath(new URL("./fixtures/j4-missing-evidence.json", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/fizot/j4-reconcile.mjs", import.meta.url));

function provider(partial: Partial<J4ProviderUsageRow> & Pick<J4ProviderUsageRow, "fizotRequestId">): J4ProviderUsageRow {
  return {
    providerRequestId: "p1",
    workspaceIdHash: "ws-a",
    model: "grok-4.3",
    inputTokens: 100,
    outputTokens: 50,
    providerCostMicro: 1000,
    currency: "USD",
    ...partial,
  };
}

function ledger(partial: Partial<J4LedgerUsageRow> & Pick<J4LedgerUsageRow, "requestId">): J4LedgerUsageRow {
  return {
    workspaceIdHash: "ws-a",
    tier: "fast",
    model: "grok-4-fast",
    providerModel: "grok-4.3",
    inputTokens: 100,
    outputTokens: 50,
    customerChargeMicroGbp: 2400,
    providerCostMicro: 1000,
    currency: "USD",
    ...partial,
  };
}

function base(overrides: Partial<J4ReconcileInput> = {}): J4ReconcileInput {
  const providerRows = overrides.providerRows ?? [provider({ fizotRequestId: "r1" })];
  const ledgerRows = overrides.ledgerRows ?? [ledger({ requestId: "r1" })];
  const defaultEvidence = syntheticEvidence({
    providerExportRecordCount: providerRows.length,
    ledgerExportRecordCount: ledgerRows.length,
    providerExportTotalBilledMicro: providerRows.reduce((sum, row) => sum + row.providerCostMicro, 0),
  });
  return {
    period: "2026-11-synthetic",
    provider: "xai",
    comparisonBasis: "provider_cost_vs_fizot_provider_cost",
    evidenceComplete: true,
    openHolds: [],
    ...overrides,
    providerRows,
    ledgerRows,
    evidence: Object.prototype.hasOwnProperty.call(overrides, "evidence")
      ? (overrides.evidence ?? null)
      : defaultEvidence,
  };
}

it("passes exact-match provider-cost reconciliation on synthetic evidence", () => {
  const report = reconcileJ4(base());
  expect(report.verdict).toBe("PASS");
  expect(report.drift).toBe(0);
  expect(report.withinThreshold).toBe(true);
  expect(report.matched).toHaveLength(1);
  expect(report.mismatched).toHaveLength(0);
  expect(report.evidenceAssessment.acceptanceEligible).toBe(false);
  expect(report.customerChargeTotalMicroGbp).toBe(2400);
  expect(report.customerChargeTotalMicroGbp).not.toBe(report.providerCostTotalMicro);
});

it("accepts aggregate and per-request variance at or below 1% and fails just above", () => {
  const under = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1005 })],
  }));
  expect(under.verdict).toBe("PASS");
  expect(under.drift).toBeLessThanOrEqual(0.01);
  expect(under.maxPerRequestDrift).toBeLessThanOrEqual(0.01);
  expect(under.materialPerRequestCount).toBe(0);

  const exact = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1010 })],
  }));
  expect(exact.matched[0]?.drift).toBeCloseTo(0.01, 10);
  expect(exact.verdict).toBe("PASS");
  expect(exact.materialPerRequestCount).toBe(0);

  const over = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1011 })],
  }));
  expect(over.verdict).toBe("FAIL");
  expect(over.drift).toBeGreaterThan(0.01);
  expect(over.materialPerRequestPolicyTriggered).toBe(true);
  expect(over.reasons).toContain("material_per_request_discrepancies");
});

it("fails when offsetting +10% and -10% discrepancies cancel in the aggregate", () => {
  const report = reconcileJ4(base({
    providerRows: [
      provider({ providerRequestId: "p-a", fizotRequestId: "r-a", providerCostMicro: 100 }),
      provider({ providerRequestId: "p-b", fizotRequestId: "r-b", providerCostMicro: 100 }),
    ],
    ledgerRows: [
      ledger({ requestId: "r-a", providerCostMicro: 110, customerChargeMicroGbp: 1 }),
      ledger({ requestId: "r-b", providerCostMicro: 90, customerChargeMicroGbp: 1 }),
    ],
  }));
  expect(report.drift).toBe(0);
  expect(report.withinThreshold).toBe(true);
  expect(report.aggregateSignedVarianceMicro).toBe(0);
  expect(report.aggregateAbsoluteVarianceMicro).toBe(20);
  expect(report.discrepancyExposureMicro).toBe(20);
  expect(report.maxPerRequestDrift).toBe(0.1);
  expect(report.materialPerRequestCount).toBe(2);
  expect(report.materialPerRequestPolicyTriggered).toBe(true);
  expect(report.verdict).toBe("FAIL");
  expect(report.reasons).toContain("material_per_request_discrepancies");
});

it("reports signed and absolute variance for zero provider cost and small rounding", () => {
  const zeroProvider = reconcileJ4(base({
    providerRows: [provider({ fizotRequestId: "r1", providerCostMicro: 0 })],
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1 })],
  }));
  expect(zeroProvider.matched[0]?.drift).toBe(1);
  expect(zeroProvider.verdict).toBe("FAIL");
  expect(zeroProvider.discrepancyExposureMicro).toBe(1);

  const tiny = reconcileJ4(base({
    providerRows: [provider({ fizotRequestId: "r1", providerCostMicro: 1 })],
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1 })],
  }));
  expect(tiny.verdict).toBe("PASS");
  expect(tiny.aggregateAbsoluteVarianceMicro).toBe(0);
});

it("sums large matched totals with safe integer arithmetic", () => {
  const report = reconcileJ4(base({
    providerRows: [
      provider({ providerRequestId: "p1", fizotRequestId: "r1", providerCostMicro: 2_000_000_000_000 }),
      provider({ providerRequestId: "p2", fizotRequestId: "r2", providerCostMicro: 2_000_000_000_000 }),
    ],
    ledgerRows: [
      ledger({ requestId: "r1", providerCostMicro: 2_000_000_000_000, customerChargeMicroGbp: 1 }),
      ledger({ requestId: "r2", providerCostMicro: 2_000_000_000_000, customerChargeMicroGbp: 1 }),
    ],
  }));
  expect(report.providerCostTotalMicro).toBe(4_000_000_000_000);
  expect(report.verdict).toBe("PASS");
});

it("fails closed on legacy boolean-only evidence even when rows match", () => {
  const report = reconcileJ4({
    period: "2026-11-synthetic",
    provider: "xai",
    comparisonBasis: "provider_cost_vs_fizot_provider_cost",
    evidenceComplete: true,
    evidence: null,
    providerRows: [provider({ fizotRequestId: "r1" })],
    ledgerRows: [ledger({ requestId: "r1" })],
  });
  expect(report.verdict).toBe("INSUFFICIENT_EVIDENCE");
  expect(report.evidenceAssessment.reasons).toContain("legacy_boolean_evidence_only");
  expect(report.evidenceAssessment.acceptanceEligible).toBe(false);
  expect(report.evidenceAssessment.independentlyVerifiable).toBe(false);
});

it("returns INSUFFICIENT_EVIDENCE for operator_export without independent verification", () => {
  const report = reconcileJ4(base({
    evidence: syntheticEvidence({
      evidenceClass: "operator_export",
      providerExportRecordCount: 1,
      ledgerExportRecordCount: 1,
      providerExportTotalBilledMicro: 1000,
      pricingVerificationStatus: "verified",
      operatorAttestsComplete: true,
    }),
  }));
  expect(report.verdict).toBe("INSUFFICIENT_EVIDENCE");
  expect(report.evidenceAssessment.structurallyValid).toBe(true);
  expect(report.evidenceAssessment.independentlyVerifiable).toBe(false);
  expect(report.evidenceAssessment.acceptanceEligible).toBe(false);
});

it("fails closed when declared evidence counts or totals disagree with rows", () => {
  const report = reconcileJ4(base({
    evidence: syntheticEvidence({
      providerExportRecordCount: 99,
      ledgerExportRecordCount: 1,
      providerExportTotalBilledMicro: 1,
    }),
  }));
  expect(report.verdict).toBe("INSUFFICIENT_EVIDENCE");
  expect(report.evidenceAssessment.structurallyValid).toBe(false);
  expect(report.evidenceAssessment.reasons).toContain("provider_export_record_count_mismatch");
  expect(report.evidenceAssessment.reasons).toContain("provider_export_total_mismatch");
});

it("rejects cross-tenant request-id collisions as dimension mismatches", () => {
  const report = reconcileJ4(base({
    providerRows: [provider({ fizotRequestId: "r1", workspaceIdHash: "ws-a" })],
    ledgerRows: [ledger({ requestId: "r1", workspaceIdHash: "ws-b" })],
  }));
  expect(report.matched).toHaveLength(0);
  expect(report.mismatched).toHaveLength(1);
  expect(report.mismatched[0]?.reasons).toContain("workspace_mismatch");
  expect(report.verdict).toBe("FAIL");
});

it("rejects model, currency, token and missing-identity mismatches", () => {
  const model = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", providerModel: "grok-4.7" })],
  }));
  expect(model.mismatched[0]?.reasons).toContain("model_mismatch");

  const currency = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", currency: "GBP" })],
    evidence: syntheticEvidence({
      providerExportRecordCount: 1,
      ledgerExportRecordCount: 1,
      providerExportTotalBilledMicro: 1000,
      currency: "USD",
    }),
  }));
  expect(currency.mismatched[0]?.reasons).toContain("currency_mismatch");
  expect(currency.reasons).toContain("mixed_currencies_in_input");

  const tokens = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", inputTokens: 999, outputTokens: 50 })],
  }));
  expect(tokens.mismatched[0]?.reasons).toContain("token_count_mismatch");

  const missingModel = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", providerModel: null })],
  }));
  expect(missingModel.mismatched[0]?.reasons).toContain("provider_model_identity_unavailable");

  const missingTokens = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", inputTokens: null, outputTokens: null })],
  }));
  expect(missingTokens.mismatched[0]?.reasons).toContain("token_identity_unavailable");

  const missingProviderId = reconcileJ4(base({
    providerRows: [provider({ fizotRequestId: "r1", providerRequestId: null })],
  }));
  expect(missingProviderId.mismatched[0]?.reasons).toContain("provider_request_id_unavailable");

  for (const report of [model, currency, tokens, missingModel, missingTokens, missingProviderId]) {
    expect(report.verdict).not.toBe("PASS");
  }
});

it("flags duplicate provider and ledger request ids", () => {
  const report = reconcileJ4(base({
    providerRows: [
      provider({ providerRequestId: "dup", fizotRequestId: "r1" }),
      provider({ providerRequestId: "dup", fizotRequestId: "r2", inputTokens: 1, outputTokens: 1 }),
    ],
    ledgerRows: [
      ledger({ requestId: "r1", providerCostMicro: 1000 }),
      ledger({ requestId: "r1", providerCostMicro: 1000 }),
    ],
  }));
  expect(report.verdict).toBe("FAIL");
  expect(report.duplicateProviderIds).toContain("dup");
  expect(report.duplicateLedgerIds).toContain("r1");
});

it("reports unmatched provider and ledger rows", () => {
  const report = reconcileJ4(base({
    providerRows: [provider({ providerRequestId: "orphan-p", fizotRequestId: null })],
    ledgerRows: [ledger({ requestId: "orphan-l" })],
  }));
  expect(report.verdict).toBe("FAIL");
  expect(report.unmatchedProvider).toHaveLength(1);
  expect(report.unmatchedLedger).toHaveLength(1);
});

it("fails when uncertain or quarantined holds remain open", () => {
  const report = reconcileJ4(base({
    openHolds: [{
      requestId: "hold-1",
      workspaceIdHash: "ws-a",
      status: "uncertain",
      amountMicroGbp: 5000,
    }],
  }));
  expect(report.verdict).toBe("FAIL");
  expect(report.reasons).toContain("open_uncertain_or_quarantined_holds");
});

it("supports multi-model rows without cross-tenant matches", () => {
  const report = reconcileJ4(base({
    providerRows: [
      provider({ providerRequestId: "p-fast", fizotRequestId: "r-fast", workspaceIdHash: "ws-a", providerCostMicro: 100, inputTokens: 10, outputTokens: 5 }),
      provider({ providerRequestId: "p-best", fizotRequestId: "r-best", workspaceIdHash: "ws-b", providerCostMicro: 200, inputTokens: 20, outputTokens: 10 }),
    ],
    ledgerRows: [
      ledger({ requestId: "r-fast", workspaceIdHash: "ws-a", tier: "fast", model: "grok-4-fast", providerCostMicro: 100, customerChargeMicroGbp: 50, inputTokens: 10, outputTokens: 5 }),
      ledger({ requestId: "r-best", workspaceIdHash: "ws-b", tier: "best", model: "grok-4-heavy", providerCostMicro: 200, customerChargeMicroGbp: 90, inputTokens: 20, outputTokens: 10 }),
    ],
  }));
  expect(report.verdict).toBe("PASS");
  expect(report.matched.map((row) => row.fizotRequestId).sort()).toEqual(["r-best", "r-fast"]);
});

it("rejects comparing customer ledger charges directly to provider cost", () => {
  expect(() => reconcileJ4(base({
    comparisonBasis: "customer_ledger_vs_provider_cost_disallowed",
  }))).toThrow(/customer_ledger_vs_provider_cost_disallowed/);
});

it("keeps capped customer charges separate from matched provider cost", () => {
  const report = reconcileJ4(base({
    ledgerRows: [ledger({ requestId: "r1", customerChargeMicroGbp: 500 })],
  }));
  expect(report.verdict).toBe("PASS");
  expect(report.providerCostTotalMicro).toBe(1000);
  expect(report.customerChargeTotalMicroGbp).toBe(500);
});

it("is deterministic across repeated runs", () => {
  const first = reconcileJ4(base());
  const second = reconcileJ4(base());
  expect(formatJ4Report(first)).toBe(formatJ4Report(second));
  expect(first).toEqual(second);
});

it("defaults maxDrift to RECONCILE_MAX_DRIFT and accepts the documented [0, max] bounds", () => {
  expect(resolveMaxDrift()).toBe(RECONCILE_MAX_DRIFT);
  expect(resolveMaxDrift(undefined)).toBe(RECONCILE_MAX_DRIFT);
  expect(resolveMaxDrift(0)).toBe(0);
  expect(resolveMaxDrift(RECONCILE_MAX_DRIFT)).toBe(RECONCILE_MAX_DRIFT);
  expect(resolveMaxDrift(0.005)).toBe(0.005);

  const defaulted = reconcileJ4(base());
  expect(defaulted.maxDrift).toBe(RECONCILE_MAX_DRIFT);

  const zero = reconcileJ4(base({
    maxDrift: 0,
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1000 })],
  }));
  expect(zero.maxDrift).toBe(0);
  expect(zero.verdict).toBe("PASS");

  const tighterFail = reconcileJ4(base({
    maxDrift: 0,
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1001 })],
  }));
  expect(tighterFail.verdict).toBe("FAIL");
  expect(tighterFail.materialPerRequestPolicyTriggered).toBe(true);

  const atMax = reconcileJ4(base({
    maxDrift: RECONCILE_MAX_DRIFT,
    ledgerRows: [ledger({ requestId: "r1", providerCostMicro: 1010 })],
  }));
  expect(atMax.maxDrift).toBe(RECONCILE_MAX_DRIFT);
  expect(atMax.verdict).toBe("PASS");
});

it("rejects invalid maxDrift overrides (NaN, Infinity, negative, above 1%)", () => {
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.001, -1, 0.0100001, 0.02, 1, 100];
  for (const maxDrift of invalid) {
    expect(() => resolveMaxDrift(maxDrift)).toThrow(/maxDrift/);
    expect(() => reconcileJ4(base({ maxDrift }))).toThrow(/maxDrift/);
  }
});

it("CLI exits 0 on exact synthetic fixture, 3 on boolean-only missing evidence", () => {
  const passed = execFileSync(process.execPath, ["--experimental-strip-types", script, exact], {
    encoding: "utf8",
  });
  expect(passed).toContain("verdict=PASS");
  expect(passed).toContain('"acceptanceEligible": false');

  let code = 0;
  let stdout = "";
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", script, missing], { encoding: "utf8" });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    code = err.status ?? 0;
    stdout = String(err.stdout ?? "");
  }
  expect(code).toBe(3);
  expect(stdout).toContain("verdict=INSUFFICIENT_EVIDENCE");
});

it("CLI rejects invalid maxDrift with exit 2 and cannot bypass reconciler validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "j4-maxdrift-"));
  const bad = join(dir, "bad-maxdrift.json");
  const payload = {
    period: "2026-11-synthetic",
    provider: "xai",
    comparisonBasis: "provider_cost_vs_fizot_provider_cost",
    maxDrift: 0.05,
    evidence: syntheticEvidence({
      providerExportRecordCount: 1,
      ledgerExportRecordCount: 1,
      providerExportTotalBilledMicro: 1000,
    }),
    providerRows: [provider({ fizotRequestId: "r1" })],
    ledgerRows: [ledger({ requestId: "r1" })],
  };
  writeFileSync(bad, JSON.stringify(payload));

  let code = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", script, bad], {
      encoding: "utf8",
    });
  } catch (error) {
    const err = error as { status?: number; stderr?: string };
    code = err.status ?? 0;
    stderr = String(err.stderr ?? "");
  }
  expect(code).toBe(2);
  expect(stderr).toMatch(/maxDrift/);
});
