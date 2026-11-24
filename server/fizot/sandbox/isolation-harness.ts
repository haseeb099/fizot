/**
 * P4.7 SE-I staging isolation acceptance harness.
 * Interprets policy and network probes for TC28/TC52/TC54/TC59.
 * Timeouts and unrelated network errors are INCONCLUSIVE, never PASS.
 */

import { FLY_STAGING_APP_PREFIX } from "../admin/fly.ts";
import {
  fizotCloudRefusal,
  type FizotEgressDecideOptions,
  type FizotEgressRefusal,
} from "./policy.ts";

export type IsolationCaseId = "TC28" | "TC59" | "TC52" | "TC54" | "SE-I";

export type DestinationClass =
  | "metadata"
  | "self-private"
  | "peer-private"
  | "dns-exfil"
  | "public"
  | "forbidden-production";

export type ProbeLayer = "policy" | "network";

export type IsolationVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type ProbeObservation =
  | { kind: "refused"; reason: string; layer: ProbeLayer }
  | { kind: "connected"; layer: ProbeLayer }
  | { kind: "timeout"; layer: ProbeLayer; ms: number }
  | { kind: "error"; layer: ProbeLayer; code?: string; message: string; class: "unrelated" | "unknown" };

export type IsolationCase = {
  id: IsolationCaseId;
  title: string;
  destinationClass: DestinationClass;
  host: string;
  port: number;
  /** Resolved addresses presented to the policy decide (literal IP targets use themselves). */
  addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>;
  expected: "refuse";
  /** Prefer these refusal reasons when the observation is a policy refuse. */
  expectedReasons?: ReadonlyArray<string>;
  layers: ReadonlyArray<ProbeLayer>;
};

export type IsolationCaseResult = {
  id: IsolationCaseId;
  title: string;
  destinationClass: DestinationClass;
  host: string;
  port: number;
  layer: ProbeLayer;
  observation: ProbeObservation;
  verdict: IsolationVerdict;
  detail: string;
  refusalReason: string | null;
};

export type IsolationTenant = {
  label: "A" | "B";
  workspaceId: string;
  appName: string;
  flyMachineId: string;
  privateIp: string;
  network: string;
};

export type IsolationEvidence = {
  schemaVersion: 1;
  gitSha: string;
  environmentType: "staging-fake" | "staging-fly";
  flyOrg: string;
  workflowRunUrl: string | null;
  tenants: IsolationTenant[];
  cases: IsolationCaseResult[];
  summary: {
    pass: number;
    fail: number;
    inconclusive: number;
    overall: IsolationVerdict | "NOT_RUN";
  };
  cleanup: {
    attempted: boolean;
    destroyedAppNames: string[];
    remainingStagingApps: string[];
    outcome: "ok" | "partial-failure" | "skipped" | "error";
    error: string | null;
  };
  costGuard: {
    maxStagingMachines: number;
    projectedDailyUsd: number | null;
    note: string;
  };
  redactions: string[];
};

export class IsolationHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationHarnessError";
  }
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bFlyV1\s+[A-Za-z0-9._=-]+/gi,
  /\bBearer\s+[A-Za-z0-9._=-]+/gi,
  /\bfizot_admin_session=[^\s;]+/gi,
  /\bFLY_API_TOKEN=[^\s]+/gi,
  /\bOMB_SLACK_RELAY_TOKEN=[^\s]+/gi,
];

/** Strip tokens and session cookies from evidence strings. */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function classifyDestination(input: {
  host: string;
  port: number;
  role: "metadata" | "self" | "peer" | "dns-exfil" | "public" | "production";
}): DestinationClass {
  if (input.role === "production") return "forbidden-production";
  if (input.role === "metadata") return "metadata";
  if (input.role === "self") return "self-private";
  if (input.role === "peer") return "peer-private";
  if (input.role === "dns-exfil" || input.port === 53 || input.port === 853) return "dns-exfil";
  return "public";
}

/**
 * Map an observation to PASS / FAIL / INCONCLUSIVE for an expected refusal.
 * Connected → FAIL. Explicit refuse with acceptable reason → PASS.
 * Timeout or unrelated error → INCONCLUSIVE (never treated as policy refuse).
 */
export function interpretIsolationProbe(input: {
  expected: "refuse";
  observation: ProbeObservation;
  expectedReasons?: ReadonlyArray<string>;
}): { verdict: IsolationVerdict; detail: string; refusalReason: string | null } {
  const { observation } = input;
  if (observation.kind === "connected") {
    return {
      verdict: "FAIL",
      detail: `expected refuse on ${observation.layer} but connection succeeded`,
      refusalReason: null,
    };
  }
  if (observation.kind === "timeout") {
    return {
      verdict: "INCONCLUSIVE",
      detail: `timeout after ${observation.ms}ms on ${observation.layer}; timeout is not proof of policy refusal`,
      refusalReason: null,
    };
  }
  if (observation.kind === "error") {
    if (observation.class === "unrelated") {
      return {
        verdict: "INCONCLUSIVE",
        detail: `unrelated ${observation.layer} error (${observation.code ?? "none"}): ${redactSecrets(observation.message)}`,
        refusalReason: null,
      };
    }
    // Network isolation often surfaces as no-route / unreachable rather than an application refuse string.
    if (
      observation.layer === "network" &&
      isNetworkIsolationCode(observation.code)
    ) {
      return {
        verdict: "PASS",
        detail: `network boundary blocked reachability (${observation.code})`,
        refusalReason: observation.code ?? "network-unreachable",
      };
    }
    return {
      verdict: "INCONCLUSIVE",
      detail: `unknown ${observation.layer} error (${observation.code ?? "none"}): ${redactSecrets(observation.message)}`,
      refusalReason: null,
    };
  }
  // refused
  const reason = observation.reason;
  if (input.expectedReasons && input.expectedReasons.length > 0) {
    if (!input.expectedReasons.includes(reason)) {
      return {
        verdict: "FAIL",
        detail: `refused with unexpected reason ${reason}; expected one of ${input.expectedReasons.join(",")}`,
        refusalReason: reason,
      };
    }
  }
  return {
    verdict: "PASS",
    detail: `${observation.layer} refused: ${reason}`,
    refusalReason: reason,
  };
}

function isNetworkIsolationCode(code: string | undefined): boolean {
  if (!code) return false;
  const normalized = code.toUpperCase();
  return (
    normalized === "ENETUNREACH" ||
    normalized === "EHOSTUNREACH" ||
    normalized === "ENETDOWN" ||
    normalized === "EPERM" ||
    // Fly / Linux sometimes reports "no route to host" without a Node code.
    normalized === "NO_ROUTE" ||
    normalized === "NETWORK_UNREACHABLE"
  );
}

/** Refuse production orgs, non-staging app names, and production process env. */
export function assertStagingTargetSafe(input: {
  org: string;
  appNames?: ReadonlyArray<string>;
  productionOrgs?: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  stagingAppPrefix?: string;
}): void {
  const env = input.env ?? process.env;
  const prefix = input.stagingAppPrefix ?? FLY_STAGING_APP_PREFIX;
  if (env.NODE_ENV === "production" || env.FIZOT_ENV === "production") {
    throw new IsolationHarnessError(
      "isolation harness refuses to run when NODE_ENV or FIZOT_ENV is production",
    );
  }
  const org = input.org.trim();
  if (!org) {
    throw new IsolationHarnessError("missing staging Fly org");
  }
  const blocked = new Set(
    (input.productionOrgs ?? parseCsv(env.FIZOT_PRODUCTION_FLY_ORGS)).map((s) => s.toLowerCase()),
  );
  if (blocked.has(org.toLowerCase())) {
    throw new IsolationHarnessError(
      `isolation harness refuses production Fly org ${org}`,
    );
  }
  for (const name of input.appNames ?? []) {
    if (!name.startsWith(prefix)) {
      throw new IsolationHarnessError(
        `isolation harness refuses non-staging app name ${name} (prefix ${prefix})`,
      );
    }
  }
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function assertStagingConfigPresent(input: {
  token?: string;
  org?: string;
  image?: string;
}): void {
  if (!input.token?.trim()) {
    throw new IsolationHarnessError("FLY_API_TOKEN is required for live isolation staging");
  }
  if (!input.org?.trim()) {
    throw new IsolationHarnessError("FLY_ORG is required for live isolation staging");
  }
  if (!input.image?.trim()) {
    throw new IsolationHarnessError("FIZOT_MACHINE_IMAGE is required for live isolation staging");
  }
}

/** Build the standard SE-I case list for tenants A (attacker) and B (peer). */
export function buildIsolationCases(input: {
  selfPrivateIp: string;
  peerPrivateIp: string;
  selfAddresses?: ReadonlySet<string>;
}): IsolationCase[] {
  const selfIp = input.selfPrivateIp.trim();
  const peerIp = input.peerPrivateIp.trim();
  if (!selfIp || !peerIp) {
    throw new IsolationHarnessError("selfPrivateIp and peerPrivateIp are required");
  }
  if (selfIp === peerIp) {
    throw new IsolationHarnessError("self and peer private IPs must differ");
  }
  const selfFamily = selfIp.includes(":") ? 6 : 4;
  const peerFamily = peerIp.includes(":") ? 6 : 4;
  return [
    {
      id: "TC52",
      title: "Metadata endpoint refusal",
      destinationClass: "metadata",
      host: "169.254.169.254",
      port: 80,
      addresses: [{ address: "169.254.169.254", family: 4 }],
      expected: "refuse",
      expectedReasons: ["metadata"],
      layers: ["policy", "network"],
    },
    {
      id: "TC54",
      title: "Own-instance private/6PN refusal",
      destinationClass: "self-private",
      host: selfIp,
      port: 443,
      addresses: [{ address: selfIp, family: selfFamily as 4 | 6 }],
      expected: "refuse",
      expectedReasons: ["self-address", "local-network", "link-local"],
      layers: ["policy", "network"],
    },
    {
      id: "TC28",
      title: "Tenant A cannot reach Tenant B (policy)",
      destinationClass: "peer-private",
      host: peerIp,
      port: 443,
      addresses: [{ address: peerIp, family: peerFamily as 4 | 6 }],
      expected: "refuse",
      expectedReasons: ["local-network", "link-local"],
      layers: ["policy"],
    },
    {
      id: "TC59",
      title: "Cross-tenant network isolation",
      destinationClass: "peer-private",
      host: peerIp,
      port: 443,
      addresses: [{ address: peerIp, family: peerFamily as 4 | 6 }],
      expected: "refuse",
      expectedReasons: ["local-network", "link-local"],
      // Network layer is the SE-I claim: Fly private network boundary, not only decide().
      layers: ["policy", "network"],
    },
  ];
}

export async function runPolicyProbe(
  target: { host: string; port: number },
  addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>,
  options: FizotEgressDecideOptions = {},
): Promise<ProbeObservation> {
  const reason: FizotEgressRefusal | null = await fizotCloudRefusal(target, addresses, options);
  if (reason === null) {
    return { kind: "connected", layer: "policy" };
  }
  return { kind: "refused", reason, layer: "policy" };
}

export type NetworkProbeFn = (target: {
  host: string;
  port: number;
  destinationClass: DestinationClass;
  caseId: IsolationCaseId;
}) => Promise<ProbeObservation>;

export async function runIsolationCases(input: {
  cases: ReadonlyArray<IsolationCase>;
  selfAddresses?: ReadonlySet<string>;
  networkProbe?: NetworkProbeFn;
}): Promise<IsolationCaseResult[]> {
  const results: IsolationCaseResult[] = [];
  for (const c of input.cases) {
    for (const layer of c.layers) {
      let observation: ProbeObservation;
      if (layer === "policy") {
        observation = await runPolicyProbe(
          { host: c.host, port: c.port },
          c.addresses,
          { selfAddresses: input.selfAddresses },
        );
      } else if (input.networkProbe) {
        observation = await input.networkProbe({
          host: c.host,
          port: c.port,
          destinationClass: c.destinationClass,
          caseId: c.id,
        });
      } else {
        observation = {
          kind: "error",
          layer: "network",
          message: "network probe not configured",
          class: "unrelated",
        };
      }
      const interpreted = interpretIsolationProbe({
        expected: c.expected,
        observation,
        expectedReasons: c.expectedReasons,
      });
      results.push({
        id: c.id,
        title: c.title,
        destinationClass: c.destinationClass,
        host: c.host,
        port: c.port,
        layer,
        observation,
        verdict: interpreted.verdict,
        detail: interpreted.detail,
        refusalReason: interpreted.refusalReason,
      });
    }
  }
  return results;
}

export function summarizeResults(results: ReadonlyArray<IsolationCaseResult>): IsolationEvidence["summary"] {
  let pass = 0;
  let fail = 0;
  let inconclusive = 0;
  for (const row of results) {
    if (row.verdict === "PASS") pass += 1;
    else if (row.verdict === "FAIL") fail += 1;
    else inconclusive += 1;
  }
  let overall: IsolationEvidence["summary"]["overall"] = "NOT_RUN";
  if (results.length === 0) overall = "NOT_RUN";
  else if (fail > 0) overall = "FAIL";
  else if (inconclusive > 0) overall = "INCONCLUSIVE";
  else overall = "PASS";
  return { pass, fail, inconclusive, overall };
}

export function buildIsolationEvidence(input: {
  gitSha: string;
  environmentType: IsolationEvidence["environmentType"];
  flyOrg: string;
  workflowRunUrl?: string | null;
  tenants: IsolationTenant[];
  cases: IsolationCaseResult[];
  cleanup: IsolationEvidence["cleanup"];
  costGuard: IsolationEvidence["costGuard"];
}): IsolationEvidence {
  return {
    schemaVersion: 1,
    gitSha: input.gitSha,
    environmentType: input.environmentType,
    flyOrg: input.flyOrg,
    workflowRunUrl: input.workflowRunUrl ?? null,
    tenants: input.tenants.map((t) => ({
      ...t,
      workspaceId: t.workspaceId, // ids are opaque staging fixtures, not customer data
    })),
    cases: input.cases.map((c) => ({
      ...c,
      detail: redactSecrets(c.detail),
      observation: redactObservation(c.observation),
    })),
    summary: summarizeResults(input.cases),
    cleanup: {
      ...input.cleanup,
      error: input.cleanup.error ? redactSecrets(input.cleanup.error) : null,
    },
    costGuard: input.costGuard,
    redactions: ["FLY_API_TOKEN", "Bearer", "FlyV1", "fizot_admin_session", "OMB_SLACK_RELAY_TOKEN"],
  };
}

function redactObservation(obs: ProbeObservation): ProbeObservation {
  if (obs.kind === "error") {
    return { ...obs, message: redactSecrets(obs.message) };
  }
  return obs;
}

/**
 * Run cleanup for every registered app name; partial failure is recorded, not swallowed silently.
 */
export async function cleanupIsolationTenants(input: {
  appNames: ReadonlyArray<string>;
  destroyApp: (appName: string) => Promise<void>;
  listStagingApps: () => Promise<string[]>;
}): Promise<IsolationEvidence["cleanup"]> {
  const destroyed: string[] = [];
  const errors: string[] = [];
  for (const name of input.appNames) {
    if (!name) continue;
    try {
      await input.destroyApp(name);
      destroyed.push(name);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let remaining: string[] = [];
  try {
    remaining = await input.listStagingApps();
  } catch (error) {
    errors.push(`list: ${error instanceof Error ? error.message : String(error)}`);
    return {
      attempted: true,
      destroyedAppNames: destroyed,
      remainingStagingApps: [],
      outcome: "error",
      error: redactSecrets(errors.join("; ")),
    };
  }
  if (errors.length > 0) {
    const partial = destroyed.length > 0;
    return {
      attempted: true,
      destroyedAppNames: destroyed,
      remainingStagingApps: remaining,
      outcome: partial ? "partial-failure" : "error",
      error: redactSecrets(errors.join("; ")),
    };
  }
  return {
    attempted: true,
    destroyedAppNames: destroyed,
    remainingStagingApps: remaining,
    outcome: remaining.length === 0 ? "ok" : "partial-failure",
    error: remaining.length === 0 ? null : `remaining staging apps: ${remaining.join(",")}`,
  };
}

/** Parse flyctl / node probe stdout into a ProbeObservation. */
export function parseNetworkProbeOutput(input: {
  stdout: string;
  stderr?: string;
  exitCode: number | null;
  timeoutMs: number;
}): ProbeObservation {
  const text = `${input.stdout}\n${input.stderr ?? ""}`;
  if (/ISOLATION_CONNECTED/i.test(text)) {
    return { kind: "connected", layer: "network" };
  }
  if (/ISOLATION_TIMEOUT/i.test(text)) {
    return { kind: "timeout", layer: "network", ms: input.timeoutMs };
  }
  const codeMatch = /ISOLATION_ERROR\s+([A-Z0-9_]+)/i.exec(text);
  if (codeMatch) {
    const code = codeMatch[1]!.toUpperCase();
    return {
      kind: "error",
      layer: "network",
      code,
      message: redactSecrets(text.trim().slice(0, 400)),
      class: isNetworkIsolationCode(code) ? "unknown" : "unrelated",
    };
  }
  if (input.exitCode === null) {
    return { kind: "timeout", layer: "network", ms: input.timeoutMs };
  }
  return {
    kind: "error",
    layer: "network",
    message: redactSecrets(text.trim().slice(0, 400) || `exit ${input.exitCode}`),
    class: "unrelated",
  };
}

/** One-liner run on a staging machine guest to probe TCP reachability. */
export function networkProbeGuestScript(host: string, port: number, timeoutMs: number): string {
  // Guest script prints ISOLATION_* markers; harness parses them.
  const h = JSON.stringify(host);
  const p = Number(port);
  const t = Math.max(500, Math.min(timeoutMs, 30_000));
  return [
    `const n=require('net');`,
    `const s=n.connect({host:${h},port:${p}});`,
    `const done=(msg,code)=>{try{console.log(msg)}catch{};process.exit(code)};`,
    `s.setTimeout(${t},()=>done('ISOLATION_TIMEOUT',3));`,
    `s.on('connect',()=>done('ISOLATION_CONNECTED',2));`,
    `s.on('error',(e)=>done('ISOLATION_ERROR '+(e&&e.code?e.code:'UNKNOWN'),4));`,
  ].join("");
}
