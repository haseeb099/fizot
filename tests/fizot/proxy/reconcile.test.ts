import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { formatReconcile, reconcileLedger } from "../../../server/fizot/proxy/reconcile.ts";

const within = fileURLToPath(new URL("./fixtures/reconcile-within.json", import.meta.url));
const over = fileURLToPath(new URL("./fixtures/reconcile-over.json", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/fizot/ledger-reconcile.mjs", import.meta.url));

it("accepts drift within 1% and rejects drift above it", () => {
  const ok = reconcileLedger({ period: "2026-11", ledgerMicroGbp: 1_000_000, providerMicroGbp: 1_005_000 });
  const bad = reconcileLedger({ period: "2026-11", ledgerMicroGbp: 1_000_000, providerMicroGbp: 1_030_000 });
  expect(ok.ok).toBe(true);
  expect(ok.drift).toBeLessThanOrEqual(0.01);
  expect(bad.ok).toBe(false);
  expect(bad.drift).toBeGreaterThan(0.01);
  const passed = execFileSync(process.execPath, ["--experimental-strip-types", script, within], { encoding: "utf8" });
  expect(passed).toContain("ok=true");
  let failed = "";
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", script, over], { encoding: "utf8" });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    expect(err.status).toBe(1);
    failed = String(err.stdout ?? "");
  }
  expect(failed).toContain("ok=false");
  console.log("reconcile_within", passed.trim());
  console.log("reconcile_over", failed.trim());
  console.log("reconcile_fn", formatReconcile(ok));
});
