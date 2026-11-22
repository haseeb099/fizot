import { expect, it } from "vitest";
import {
  assertStagingConfigPresent,
  assertStagingTargetSafe,
  buildIsolationCases,
  buildIsolationEvidence,
  cleanupIsolationTenants,
  interpretIsolationProbe,
  IsolationHarnessError,
  networkProbeGuestScript,
  parseNetworkProbeOutput,
  redactSecrets,
  runIsolationCases,
  summarizeResults,
} from "../../../server/fizot/sandbox/isolation-harness.ts";

it("PASS when policy refuses with an expected reason", () => {
  const r = interpretIsolationProbe({
    expected: "refuse",
    observation: { kind: "refused", reason: "metadata", layer: "policy" },
    expectedReasons: ["metadata"],
  });
  expect(r.verdict).toBe("PASS");
  expect(r.refusalReason).toBe("metadata");
});

it("FAIL when a prohibited connection succeeds", () => {
  const r = interpretIsolationProbe({
    expected: "refuse",
    observation: { kind: "connected", layer: "network" },
  });
  expect(r.verdict).toBe("FAIL");
  expect(r.refusalReason).toBeNull();
});

it("INCONCLUSIVE on unrelated network timeout (never treated as refuse)", () => {
  const r = interpretIsolationProbe({
    expected: "refuse",
    observation: { kind: "timeout", layer: "network", ms: 3000 },
  });
  expect(r.verdict).toBe("INCONCLUSIVE");
  expect(r.detail).toMatch(/not proof of policy refusal/);
});

it("INCONCLUSIVE on unrelated network errors", () => {
  const r = interpretIsolationProbe({
    expected: "refuse",
    observation: {
      kind: "error",
      layer: "network",
      code: "EAI_AGAIN",
      message: "getaddrinfo EAI_AGAIN",
      class: "unrelated",
    },
  });
  expect(r.verdict).toBe("INCONCLUSIVE");
});

it("PASS on network unreachable codes that prove the boundary", () => {
  const r = interpretIsolationProbe({
    expected: "refuse",
    observation: {
      kind: "error",
      layer: "network",
      code: "ENETUNREACH",
      message: "connect ENETUNREACH",
      class: "unknown",
    },
  });
  expect(r.verdict).toBe("PASS");
  expect(r.refusalReason).toBe("ENETUNREACH");
});

it("ECONNREFUSED on peer is not isolation proof", () => {
  const r = interpretIsolationProbe({
    expected: "refuse",
    observation: {
      kind: "error",
      layer: "network",
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED",
      class: "unknown",
    },
  });
  expect(r.verdict).toBe("INCONCLUSIVE");
});

it("refuses missing staging configuration", () => {
  expect(() => assertStagingConfigPresent({})).toThrow(IsolationHarnessError);
  expect(() => assertStagingConfigPresent({ token: "t", org: "fizot" })).toThrow(/FIZOT_MACHINE_IMAGE/);
  expect(() =>
    assertStagingConfigPresent({ token: "t", org: "fizot", image: "registry.fly.io/x:staging" }),
  ).not.toThrow();
});

it("refuses production process env and production org targets", () => {
  expect(() =>
    assertStagingTargetSafe({
      org: "fizot",
      env: { FIZOT_ENV: "production" },
    }),
  ).toThrow(/production/);
  expect(() =>
    assertStagingTargetSafe({
      org: "customer-prod",
      productionOrgs: ["customer-prod"],
      env: { FIZOT_ENV: "staging" },
    }),
  ).toThrow(/production Fly org/);
  expect(() =>
    assertStagingTargetSafe({
      org: "fizot",
      appNames: ["prod-customer-app"],
      env: {},
    }),
  ).toThrow(/non-staging app name/);
  expect(() =>
    assertStagingTargetSafe({
      org: "fizot",
      appNames: ["fizot-cm-abc123"],
      env: { FIZOT_ENV: "staging" },
    }),
  ).not.toThrow();
});

it("records provisioning failure as thrown IsolationHarnessError before probes", () => {
  expect(() =>
    buildIsolationCases({ selfPrivateIp: "", peerPrivateIp: "fdaa:0:0::2" }),
  ).toThrow(/required/);
  expect(() =>
    buildIsolationCases({ selfPrivateIp: "fdaa:0:0::1", peerPrivateIp: "fdaa:0:0::1" }),
  ).toThrow(/must differ/);
});

it("cleanup records partial failure when one destroy fails", async () => {
  const cleanup = await cleanupIsolationTenants({
    appNames: ["fizot-cm-a", "fizot-cm-b"],
    destroyApp: async (name) => {
      if (name === "fizot-cm-b") throw new Error("fly 500");
    },
    listStagingApps: async () => ["fizot-cm-b"],
  });
  expect(cleanup.outcome).toBe("partial-failure");
  expect(cleanup.destroyedAppNames).toEqual(["fizot-cm-a"]);
  expect(cleanup.remainingStagingApps).toEqual(["fizot-cm-b"]);
  expect(cleanup.error).toMatch(/fizot-cm-b/);
});

it("runs policy probes for the standard SE-I cases", async () => {
  const cases = buildIsolationCases({
    selfPrivateIp: "fdaa:0:0::1",
    peerPrivateIp: "fdaa:0:0::2",
  });
  const results = await runIsolationCases({
    cases: cases.map((c) => ({ ...c, layers: ["policy"] as const })),
    selfAddresses: new Set(["fdaa:0:0::1"]),
  });
  expect(results.every((r) => r.verdict === "PASS")).toBe(true);
  expect(results.map((r) => r.id).sort()).toEqual(["TC28", "TC52", "TC54", "TC59"]);
});

it("FAIL when network probe unexpectedly connects", async () => {
  const cases = buildIsolationCases({
    selfPrivateIp: "fdaa:0:0::1",
    peerPrivateIp: "fdaa:0:0::2",
  }).filter((c) => c.id === "TC59");
  const results = await runIsolationCases({
    cases: cases.map((c) => ({ ...c, layers: ["network"] as const })),
    networkProbe: async () => ({ kind: "connected", layer: "network" }),
  });
  expect(results[0]!.verdict).toBe("FAIL");
  expect(summarizeResults(results).overall).toBe("FAIL");
});

it("builds redacted machine-readable evidence", () => {
  const evidence = buildIsolationEvidence({
    gitSha: "abc123",
    environmentType: "staging-fake",
    flyOrg: "fizot",
    workflowRunUrl: "https://github.com/haseeb099/fizot/actions/runs/1",
    tenants: [
      {
        label: "A",
        workspaceId: "ws-a",
        appName: "fizot-cm-a",
        flyMachineId: "mach_1",
        privateIp: "fdaa:0:0::1",
        network: "fizot-net-1",
      },
      {
        label: "B",
        workspaceId: "ws-b",
        appName: "fizot-cm-b",
        flyMachineId: "mach_2",
        privateIp: "fdaa:0:0::2",
        network: "fizot-net-2",
      },
    ],
    cases: [
      {
        id: "TC52",
        title: "Metadata",
        destinationClass: "metadata",
        host: "169.254.169.254",
        port: 80,
        layer: "policy",
        observation: { kind: "refused", reason: "metadata", layer: "policy" },
        verdict: "PASS",
        detail: "policy refused: metadata Bearer secret-token",
        refusalReason: "metadata",
      },
    ],
    cleanup: {
      attempted: true,
      destroyedAppNames: ["fizot-cm-a", "fizot-cm-b"],
      remainingStagingApps: [],
      outcome: "ok",
      error: null,
    },
    costGuard: {
      maxStagingMachines: 2,
      projectedDailyUsd: 1.23,
      note: "two disposable staging machines",
    },
  });
  expect(evidence.schemaVersion).toBe(1);
  expect(evidence.cases[0]!.detail).toContain("[REDACTED]");
  expect(evidence.cases[0]!.detail).not.toContain("secret-token");
  expect(evidence.summary.overall).toBe("PASS");
});

it("redacts Fly tokens from free-form strings", () => {
  expect(redactSecrets("FlyV1 abc.def Authorization Bearer tok")).toMatch(/\[REDACTED\]/);
});

it("parses guest probe markers", () => {
  expect(parseNetworkProbeOutput({
    stdout: "ISOLATION_CONNECTED\n",
    exitCode: 2,
    timeoutMs: 3000,
  }).kind).toBe("connected");
  expect(parseNetworkProbeOutput({
    stdout: "ISOLATION_TIMEOUT\n",
    exitCode: 3,
    timeoutMs: 3000,
  }).kind).toBe("timeout");
  const err = parseNetworkProbeOutput({
    stdout: "ISOLATION_ERROR ENETUNREACH\n",
    exitCode: 4,
    timeoutMs: 3000,
  });
  expect(err.kind).toBe("error");
  if (err.kind === "error") expect(err.code).toBe("ENETUNREACH");
});

it("guest script embeds host/port/timeout markers", () => {
  const script = networkProbeGuestScript("fdaa:0:0::2", 443, 2500);
  expect(script).toContain("fdaa:0:0::2");
  expect(script).toContain("443");
  expect(script).toContain("ISOLATION_CONNECTED");
});
