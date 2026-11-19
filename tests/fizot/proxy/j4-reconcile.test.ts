import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { formatJ4Report, reconcileJ4, type J4ReconcileInput } from "../../../server/fizot/proxy/j4-reconcile.ts";

const exact = fileURLToPath(new URL("./fixtures/j4-exact.json", import.meta.url));
const missing = fileURLToPath(new URL("./fixtures/j4-missing-evidence.json", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/fizot/j4-reconcile.mjs", import.meta.url));

function base(overrides: Partial<J4ReconcileInput> = {}): J4ReconcileInput {
  return {
    period: "2026-11-synthetic",
    provider: "xai",
    comparisonBasis: "provider_cost_vs_fizot_provider_cost",
    evidenceComplete: true,
    providerRows: [
      {
        providerRequestId: "p1",
        fizotRequestId: "r1",
        workspaceIdHash: "ws-a",
        model: "grok-4.3",
        inputTokens: 100,
        outputTokens: 50,
        providerCostMicro: 1000,
        currency: "USD",
      },
    ],
    ledgerRows: [
      {
        requestId: "r1",
        workspaceIdHash: "ws-a",
        tier: "fast",
        model: "grok-4-fast",
        inputTokens: 100,
        outputTokens: 50,
        customerChargeMicroGbp: 2400,
        providerCostMicro: 1000,
        currency: "USD",
      },
    ],
    openHolds: [],
    ...overrides,
  };
}

it("passes exact-match provider-cost reconciliation", () => {
  const report = reconcileJ4(base());
  expect(report.verdict).toBe("PASS");
  expect(report.drift).toBe(0);
  expect(report.withinThreshold).toBe(true);
  expect(report.matched).toHaveLength(1);
  expect(report.customerChargeTotalMicroGbp).toBe(2400);
  expect(report.customerChargeTotalMicroGbp).not.toBe(report.providerCostTotalMicro);
});

it("accepts variance below 1% and fails above 1%", () => {
  const under = reconcileJ4(base({
    ledgerRows: [{
      requestId: "r1",
      workspaceIdHash: "ws-a",
      tier: "fast",
      model: "grok-4-fast",
      inputTokens: 100,
      outputTokens: 50,
      customerChargeMicroGbp: 2400,
      providerCostMicro: 1005,
      currency: "USD",
    }],
  }));
  expect(under.verdict).toBe("PASS");
  expect(under.drift).toBeLessThanOrEqual(0.01);

  const over = reconcileJ4(base({
    ledgerRows: [{
      requestId: "r1",
      workspaceIdHash: "ws-a",
      tier: "fast",
      model: "grok-4-fast",
      inputTokens: 100,
      outputTokens: 50,
      customerChargeMicroGbp: 2400,
      providerCostMicro: 1030,
      currency: "USD",
    }],
  }));
  expect(over.verdict).toBe("FAIL");
  expect(over.drift).toBeGreaterThan(0.01);
  expect(over.reasons).toContain("provider_cost_drift_over_threshold");
});

it("fails closed when provider evidence is incomplete or absent", () => {
  const incomplete = reconcileJ4(base({ evidenceComplete: false }));
  expect(incomplete.verdict).toBe("INSUFFICIENT_EVIDENCE");
  expect(incomplete.reasons).toContain("provider_or_ledger_evidence_incomplete");

  const empty = reconcileJ4(base({
    evidenceComplete: false,
    providerRows: [],
    ledgerRows: [],
  }));
  expect(empty.verdict).toBe("INSUFFICIENT_EVIDENCE");
});

it("flags duplicate provider and ledger request ids", () => {
  const report = reconcileJ4(base({
    providerRows: [
      {
        providerRequestId: "dup",
        fizotRequestId: "r1",
        workspaceIdHash: "ws-a",
        model: "grok-4.3",
        inputTokens: 1,
        outputTokens: 1,
        providerCostMicro: 1000,
        currency: "USD",
      },
      {
        providerRequestId: "dup",
        fizotRequestId: "r2",
        workspaceIdHash: "ws-a",
        model: "grok-4.3",
        inputTokens: 1,
        outputTokens: 1,
        providerCostMicro: 1000,
        currency: "USD",
      },
    ],
    ledgerRows: [
      {
        requestId: "r1",
        workspaceIdHash: "ws-a",
        tier: "fast",
        model: null,
        inputTokens: 1,
        outputTokens: 1,
        customerChargeMicroGbp: 1,
        providerCostMicro: 1000,
        currency: "USD",
      },
      {
        requestId: "r1",
        workspaceIdHash: "ws-a",
        tier: "fast",
        model: null,
        inputTokens: 1,
        outputTokens: 1,
        customerChargeMicroGbp: 1,
        providerCostMicro: 1000,
        currency: "USD",
      },
    ],
  }));
  expect(report.verdict).toBe("FAIL");
  expect(report.duplicateProviderIds).toContain("dup");
  expect(report.duplicateLedgerIds).toContain("r1");
});

it("reports unmatched provider and ledger rows", () => {
  const report = reconcileJ4(base({
    providerRows: [
      {
        providerRequestId: "orphan-p",
        fizotRequestId: null,
        workspaceIdHash: "ws-a",
        model: "grok-4.3",
        inputTokens: 1,
        outputTokens: 1,
        providerCostMicro: 100,
        currency: "USD",
      },
    ],
    ledgerRows: [
      {
        requestId: "orphan-l",
        workspaceIdHash: "ws-a",
        tier: "fast",
        model: null,
        inputTokens: 1,
        outputTokens: 1,
        customerChargeMicroGbp: 10,
        providerCostMicro: 100,
        currency: "USD",
      },
    ],
  }));
  expect(report.verdict).toBe("FAIL");
  expect(report.unmatchedProvider).toHaveLength(1);
  expect(report.unmatchedLedger).toHaveLength(1);
  expect(report.reasons).toContain("unmatched_provider_rows");
  expect(report.reasons).toContain("unmatched_ledger_rows");
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

it("supports multi-model rows and isolates workspace hashes in matches", () => {
  const report = reconcileJ4(base({
    providerRows: [
      {
        providerRequestId: "p-fast",
        fizotRequestId: "r-fast",
        workspaceIdHash: "ws-a",
        model: "grok-4.3",
        inputTokens: 10,
        outputTokens: 5,
        providerCostMicro: 100,
        currency: "USD",
      },
      {
        providerRequestId: "p-best",
        fizotRequestId: "r-best",
        workspaceIdHash: "ws-b",
        model: "grok-4.3",
        inputTokens: 20,
        outputTokens: 10,
        providerCostMicro: 200,
        currency: "USD",
      },
    ],
    ledgerRows: [
      {
        requestId: "r-fast",
        workspaceIdHash: "ws-a",
        tier: "fast",
        model: "grok-4-fast",
        inputTokens: 10,
        outputTokens: 5,
        customerChargeMicroGbp: 50,
        providerCostMicro: 100,
        currency: "USD",
      },
      {
        requestId: "r-best",
        workspaceIdHash: "ws-b",
        tier: "best",
        model: "grok-4-heavy",
        inputTokens: 20,
        outputTokens: 10,
        customerChargeMicroGbp: 90,
        providerCostMicro: 200,
        currency: "USD",
      },
    ],
  }));
  expect(report.verdict).toBe("PASS");
  expect(report.matched.map((row) => row.fizotRequestId).sort()).toEqual(["r-best", "r-fast"]);
  expect(new Set(report.matched.map((row) => row.fizotRequestId)).size).toBe(2);
});

it("rejects comparing customer ledger charges directly to provider cost", () => {
  expect(() => reconcileJ4(base({
    comparisonBasis: "customer_ledger_vs_provider_cost_disallowed",
  }))).toThrow(/customer_ledger_vs_provider_cost_disallowed/);
});

it("keeps capped customer charges separate from matched provider cost", () => {
  const report = reconcileJ4(base({
    ledgerRows: [{
      requestId: "r1",
      workspaceIdHash: "ws-a",
      tier: "fast",
      model: "grok-4-fast",
      inputTokens: 100,
      outputTokens: 50,
      // Customer settle clamped to reservation; provider still billed full usage cost.
      customerChargeMicroGbp: 500,
      providerCostMicro: 1000,
      currency: "USD",
    }],
  }));
  expect(report.verdict).toBe("PASS");
  expect(report.providerCostTotalMicro).toBe(1000);
  expect(report.customerChargeTotalMicroGbp).toBe(500);
  expect(report.customerChargeTotalMicroGbp).toBeLessThan(report.providerCostTotalMicro);
});

it("does not cross-match ledger rows across workspace hashes without shared request ids", () => {
  const report = reconcileJ4(base({
    providerRows: [{
      providerRequestId: "p-a",
      fizotRequestId: "shared-looking",
      workspaceIdHash: "ws-a",
      model: "grok-4.3",
      inputTokens: 1,
      outputTokens: 1,
      providerCostMicro: 100,
      currency: "USD",
    }],
    ledgerRows: [{
      requestId: "other-id",
      workspaceIdHash: "ws-b",
      tier: "fast",
      model: "grok-4-fast",
      inputTokens: 1,
      outputTokens: 1,
      customerChargeMicroGbp: 10,
      providerCostMicro: 100,
      currency: "USD",
    }],
  }));
  expect(report.matched).toHaveLength(0);
  expect(report.unmatchedProvider[0]?.workspaceIdHash).toBe("ws-a");
  expect(report.unmatchedLedger[0]?.workspaceIdHash).toBe("ws-b");
  expect(report.verdict).toBe("FAIL");
});

it("is deterministic across repeated runs", () => {
  const first = reconcileJ4(base());
  const second = reconcileJ4(base());
  expect(formatJ4Report(first)).toBe(formatJ4Report(second));
  expect(first).toEqual(second);
});

it("CLI exits 0 on exact fixture, 3 on missing evidence", () => {
  const passed = execFileSync(process.execPath, ["--experimental-strip-types", script, exact], {
    encoding: "utf8",
  });
  expect(passed).toContain("verdict=PASS");
  expect(passed).toContain('"verdict": "PASS"');

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
