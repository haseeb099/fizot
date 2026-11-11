import type { J9TrackedResources } from "./j9-run-artifact.ts";

export type J9ScenarioStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type J9EventSource =
  | "stripe_api"
  | "locally_signed_fixture"
  | "simulated_clock"
  | "config"
  | "none"
  | "stripe_cli_capture";
export type J9Kind = "fake_unit" | "live_j9";

export type J9ScenarioResult = {
  scenario: string;
  status: J9ScenarioStatus;
  source: J9EventSource;
  evidence: string;
  failureReason?: string;
  cleanup?: string;
};

export type J9Report = {
  kind: J9Kind;
  /** True only for a complete live Stripe J9 acceptance run. */
  liveAcceptance: boolean;
  overall: "PASS" | "FAIL" | "BLOCKED";
  exitCode: number;
  scenarios: J9ScenarioResult[];
  resources: J9TrackedResources;
  artifactPath?: string | null;
  runId?: string | null;
  checkoutUrl?: string | null;
};

export function formatJ9Report(report: J9Report): string {
  return [
    `j9_kind=${report.kind} live_acceptance=${report.liveAcceptance} overall=${report.overall} exit=${report.exitCode}`,
    report.runId ? `j9_run_id=${report.runId}` : null,
    report.artifactPath ? `j9_artifact=${report.artifactPath}` : null,
    report.checkoutUrl ? `j9_checkout_url=${report.checkoutUrl}` : null,
    ...report.scenarios.map((row) => {
      const fail = row.failureReason ? ` failure=${JSON.stringify(row.failureReason)}` : "";
      const cleanup = row.cleanup ? ` cleanup=${row.cleanup}` : "";
      return `j9_scenario name=${row.scenario} status=${row.status} source=${row.source} evidence=${JSON.stringify(row.evidence)}${fail}${cleanup}`;
    }),
    `j9_resources customers=${report.resources.customers.length} subscriptions=${report.resources.subscriptions.length} checkout_sessions=${report.resources.checkoutSessions.length} test_clocks=${report.resources.testClocks.length}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}
