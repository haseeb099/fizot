/**
 * Non-secret J9 live-run artifact. Integrity uses an independently stored
 * HMAC secret that is never written into the artifact file.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const J9_RUN_ARTIFACT_SCHEMA = 3 as const;
export const J9_ARTIFACT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const J9_FIXED_ARTIFACT_RELATIVE = join("artifacts", "j9", "run.json");
export const J9_FIXED_CAPTURE_RELATIVE = join("artifacts", "j9", "webhook-capture.json");

/** Authenticated lifecycle stages for staged live J9. */
export type J9RunStage =
  | "awaiting_checkout"
  | "awaiting_evidence"
  | "retryable_failure"
  | "cleanup_partial"
  | "completed"
  | "abandoned";

export type J9LifecycleTransition = {
  at: string;
  from: J9RunStage | "none";
  to: J9RunStage;
  reason: string;
};

export type J9TrackedResources = {
  customers: string[];
  subscriptions: string[];
  checkoutSessions: string[];
  testClocks: string[];
};

export type J9RunArtifact = {
  schemaVersion: typeof J9_RUN_ARTIFACT_SCHEMA;
  kind: "live_j9_run";
  runId: string;
  stage: J9RunStage;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  workspaceId: string;
  priceHome: string;
  priceTeam: string;
  pauseCleanup: boolean;
  /** True when another resume may continue without recreating Stripe resources. */
  retrySafe: boolean;
  checkout: {
    customerId: string;
    sessionId: string;
    expectedPriceId: string;
    /** Filled after genuine Checkout completion. */
    subscriptionId: string | null;
  };
  clock: {
    clockId: string;
    frozenTime: number;
    customerId: string;
    subscriptionId: string | null;
    baselineInvoiceId: string | null;
    /** Stripe event ids observed at baseline (excluded from recovery evidence). */
    baselineEventIds: string[];
  };
  resources: J9TrackedResources;
  transitions: J9LifecycleTransition[];
  /** HMAC-SHA256 hex over the authenticated payload. Never derived from artifact-only material. */
  artifactMac: string;
};

export type ArtifactValidation =
  | { ok: true; artifact: J9RunArtifact }
  | { ok: false; reason: string };

export type ParseArtifactOptions = {
  /** Cleanup of expired runs still verifies MAC but ignores expiry. */
  allowExpired?: boolean;
};

const STAGES: ReadonlySet<J9RunStage> = new Set([
  "awaiting_checkout",
  "awaiting_evidence",
  "retryable_failure",
  "cleanup_partial",
  "completed",
  "abandoned",
]);

function requireId(value: unknown, prefix: string): string | null {
  return typeof value === "string" && value.startsWith(prefix) ? value : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStage(value: unknown): value is J9RunStage {
  return typeof value === "string" && STAGES.has(value as J9RunStage);
}

function parseTransitions(raw: unknown): J9LifecycleTransition[] | null {
  if (!Array.isArray(raw)) return null;
  const out: J9LifecycleTransition[] = [];
  for (const row of raw) {
    if (row == null || typeof row !== "object" || Array.isArray(row)) return null;
    const item = row as Record<string, unknown>;
    if (typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at))) return null;
    if (item.from !== "none" && !isStage(item.from)) return null;
    if (!isStage(item.to)) return null;
    if (typeof item.reason !== "string" || !item.reason || item.reason.length > 200) return null;
    out.push({
      at: item.at,
      from: item.from as J9LifecycleTransition["from"],
      to: item.to,
      reason: item.reason,
    });
  }
  return out;
}

export function createRunId(): string {
  return `j9run_${randomBytes(12).toString("hex")}`;
}

export function assertArtifactHmacSecret(secret: string | null | undefined): { ok: true; secret: string } | { ok: false; reason: string } {
  const value = (secret ?? "").trim();
  if (!value) return { ok: false, reason: "artifact_hmac_secret_missing" };
  if (value.startsWith("sk_test_") || value.startsWith("sk_live_") || value.startsWith("whsec_")) {
    return { ok: false, reason: "artifact_hmac_secret_must_not_be_stripe_credential" };
  }
  if (value.length < 32) return { ok: false, reason: "artifact_hmac_secret_too_short" };
  return { ok: true, secret: value };
}

/** Stable JSON for MAC input. Excludes artifactMac. */
export function authenticatedPayload(artifact: Omit<J9RunArtifact, "artifactMac">): string {
  const body = {
    schemaVersion: artifact.schemaVersion,
    kind: artifact.kind,
    runId: artifact.runId,
    stage: artifact.stage,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    expiresAt: artifact.expiresAt,
    workspaceId: artifact.workspaceId,
    priceHome: artifact.priceHome,
    priceTeam: artifact.priceTeam,
    pauseCleanup: artifact.pauseCleanup,
    retrySafe: artifact.retrySafe,
    checkout: {
      customerId: artifact.checkout.customerId,
      sessionId: artifact.checkout.sessionId,
      expectedPriceId: artifact.checkout.expectedPriceId,
      subscriptionId: artifact.checkout.subscriptionId,
    },
    clock: {
      clockId: artifact.clock.clockId,
      frozenTime: artifact.clock.frozenTime,
      customerId: artifact.clock.customerId,
      subscriptionId: artifact.clock.subscriptionId,
      baselineInvoiceId: artifact.clock.baselineInvoiceId,
      baselineEventIds: [...artifact.clock.baselineEventIds].sort(),
    },
    resources: {
      customers: [...artifact.resources.customers].sort(),
      subscriptions: [...artifact.resources.subscriptions].sort(),
      checkoutSessions: [...artifact.resources.checkoutSessions].sort(),
      testClocks: [...artifact.resources.testClocks].sort(),
    },
    transitions: artifact.transitions.map((row) => ({
      at: row.at,
      from: row.from,
      to: row.to,
      reason: row.reason,
    })),
  };
  return JSON.stringify(body);
}

export function computeArtifactMac(hmacSecret: string, artifact: Omit<J9RunArtifact, "artifactMac">): string {
  return createHmac("sha256", hmacSecret).update(authenticatedPayload(artifact)).digest("hex");
}

export function sealArtifact(
  hmacSecret: string,
  input: Omit<J9RunArtifact, "artifactMac" | "updatedAt" | "expiresAt"> & {
    updatedAt?: string;
    expiresAt?: string;
  },
): J9RunArtifact {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const createdMs = Date.parse(input.createdAt);
  const expiresAt = input.expiresAt
    ?? new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + J9_ARTIFACT_MAX_AGE_MS).toISOString();
  const base: Omit<J9RunArtifact, "artifactMac"> = {
    ...input,
    updatedAt,
    expiresAt,
  };
  return {
    ...base,
    artifactMac: computeArtifactMac(hmacSecret, base),
  };
}

export function appendTransition(
  hmacSecret: string,
  artifact: J9RunArtifact,
  to: J9RunStage,
  reason: string,
  extras: Partial<Omit<J9RunArtifact, "artifactMac" | "stage" | "transitions" | "updatedAt">> = {},
): J9RunArtifact {
  const at = new Date().toISOString();
  return sealArtifact(hmacSecret, {
    ...artifact,
    ...extras,
    stage: to,
    transitions: [
      ...artifact.transitions,
      { at, from: artifact.stage, to, reason: reason.slice(0, 200) },
    ],
    updatedAt: at,
  });
}

export function verifyArtifactMac(hmacSecret: string, artifact: J9RunArtifact): boolean {
  const { artifactMac, ...rest } = artifact;
  const expected = computeArtifactMac(hmacSecret, rest);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(artifactMac, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function parseJ9RunArtifact(
  raw: unknown,
  hmacSecret: string,
  nowMs = Date.now(),
  options: ParseArtifactOptions = {},
): ArtifactValidation {
  const secretOk = assertArtifactHmacSecret(hmacSecret);
  if (!secretOk.ok) return { ok: false, reason: secretOk.reason };
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "artifact_not_object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== J9_RUN_ARTIFACT_SCHEMA) {
    return { ok: false, reason: "artifact_schema_mismatch" };
  }
  if (obj.kind !== "live_j9_run") return { ok: false, reason: "artifact_kind_invalid" };
  const runId = typeof obj.runId === "string" && obj.runId.startsWith("j9run_") ? obj.runId : null;
  if (!runId) return { ok: false, reason: "artifact_run_id_invalid" };
  if (!isStage(obj.stage)) return { ok: false, reason: "artifact_stage_invalid" };
  if (typeof obj.artifactMac !== "string" || obj.artifactMac.length !== 64) {
    return { ok: false, reason: "artifact_mac_invalid" };
  }
  if (typeof obj.workspaceId !== "string" || !obj.workspaceId.startsWith("ws_j9_")) {
    return { ok: false, reason: "artifact_workspace_invalid" };
  }
  if (typeof obj.priceHome !== "string" || !obj.priceHome.startsWith("price_")) {
    return { ok: false, reason: "artifact_price_home_invalid" };
  }
  if (typeof obj.priceTeam !== "string" || !obj.priceTeam.startsWith("price_")) {
    return { ok: false, reason: "artifact_price_team_invalid" };
  }
  if (typeof obj.createdAt !== "string" || typeof obj.updatedAt !== "string" || typeof obj.expiresAt !== "string") {
    return { ok: false, reason: "artifact_timestamps_invalid" };
  }
  if (typeof obj.pauseCleanup !== "boolean") return { ok: false, reason: "artifact_pause_cleanup_invalid" };
  if (typeof obj.retrySafe !== "boolean") return { ok: false, reason: "artifact_retry_safe_invalid" };
  const transitions = parseTransitions(obj.transitions);
  if (!transitions) return { ok: false, reason: "artifact_transitions_invalid" };
  const checkout = obj.checkout as Record<string, unknown> | undefined;
  const clock = obj.clock as Record<string, unknown> | undefined;
  const resources = obj.resources as Record<string, unknown> | undefined;
  if (!checkout || !clock || !resources) return { ok: false, reason: "artifact_sections_missing" };
  const customerId = requireId(checkout.customerId, "cus_");
  const sessionId = requireId(checkout.sessionId, "cs_");
  const expectedPriceId = requireId(checkout.expectedPriceId, "price_");
  if (!customerId || !sessionId || !expectedPriceId) return { ok: false, reason: "artifact_checkout_ids_invalid" };
  const checkoutSub = checkout.subscriptionId == null ? null : requireId(checkout.subscriptionId, "sub_");
  if (checkout.subscriptionId != null && !checkoutSub) return { ok: false, reason: "artifact_checkout_subscription_invalid" };
  const clockId = requireId(clock.clockId, "clock_");
  const clockCustomerId = requireId(clock.customerId, "cus_");
  if (!clockId || !clockCustomerId || typeof clock.frozenTime !== "number") {
    return { ok: false, reason: "artifact_clock_ids_invalid" };
  }
  if (!isStringArray(clock.baselineEventIds)) return { ok: false, reason: "artifact_baseline_events_invalid" };
  if (
    !isStringArray(resources.customers)
    || !isStringArray(resources.subscriptions)
    || !isStringArray(resources.checkoutSessions)
    || !isStringArray(resources.testClocks)
  ) {
    return { ok: false, reason: "artifact_resources_invalid" };
  }
  const artifact: J9RunArtifact = {
    schemaVersion: J9_RUN_ARTIFACT_SCHEMA,
    kind: "live_j9_run",
    runId,
    stage: obj.stage,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    expiresAt: obj.expiresAt,
    workspaceId: obj.workspaceId,
    priceHome: obj.priceHome,
    priceTeam: obj.priceTeam,
    pauseCleanup: obj.pauseCleanup,
    retrySafe: obj.retrySafe,
    checkout: { customerId, sessionId, expectedPriceId, subscriptionId: checkoutSub },
    clock: {
      clockId,
      frozenTime: clock.frozenTime,
      customerId: clockCustomerId,
      subscriptionId: clock.subscriptionId == null ? null : requireId(clock.subscriptionId, "sub_"),
      baselineInvoiceId: clock.baselineInvoiceId == null ? null : requireId(clock.baselineInvoiceId, "in_"),
      baselineEventIds: clock.baselineEventIds,
    },
    resources: {
      customers: resources.customers,
      subscriptions: resources.subscriptions,
      checkoutSessions: resources.checkoutSessions,
      testClocks: resources.testClocks,
    },
    transitions,
    artifactMac: obj.artifactMac,
  };
  if (artifact.clock.subscriptionId === null && clock.subscriptionId != null) {
    return { ok: false, reason: "artifact_clock_subscription_invalid" };
  }
  if (artifact.clock.baselineInvoiceId === null && clock.baselineInvoiceId != null) {
    return { ok: false, reason: "artifact_clock_invoice_invalid" };
  }
  if (!verifyArtifactMac(secretOk.secret, artifact)) {
    return { ok: false, reason: "artifact_mac_mismatch" };
  }
  const expiresMs = Date.parse(artifact.expiresAt);
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: "artifact_expires_invalid" };
  if (!options.allowExpired && expiresMs < nowMs) {
    return { ok: false, reason: "artifact_expired" };
  }
  if (artifact.checkout.customerId !== "cus_missing" && !artifact.resources.customers.includes(artifact.checkout.customerId)) {
    return { ok: false, reason: "artifact_checkout_customer_untracked" };
  }
  if (artifact.clock.customerId !== "cus_missing" && !artifact.resources.customers.includes(artifact.clock.customerId)) {
    return { ok: false, reason: "artifact_clock_customer_untracked" };
  }
  if (artifact.checkout.sessionId !== "cs_missing" && !artifact.resources.checkoutSessions.includes(artifact.checkout.sessionId)) {
    return { ok: false, reason: "artifact_session_untracked" };
  }
  if (artifact.clock.clockId !== "clock_missing" && !artifact.resources.testClocks.includes(artifact.clock.clockId)) {
    return { ok: false, reason: "artifact_clock_untracked" };
  }
  return { ok: true, artifact };
}

/** Refuse path traversal / arbitrary operator paths. */
export function resolveSafeJ9Path(repoRoot: string, relativeFixed: string): { ok: true; path: string } | { ok: false; reason: string } {
  const root = resolve(repoRoot);
  const full = resolve(root, relativeFixed);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) return { ok: false, reason: "artifact_path_escape" };
  if (!full.replace(/\\/g, "/").includes("/artifacts/j9/")) return { ok: false, reason: "artifact_path_not_j9_dir" };
  return { ok: true, path: full };
}

export function loadJ9RunArtifact(
  path: string,
  hmacSecret: string,
  nowMs = Date.now(),
  options: ParseArtifactOptions = {},
): ArtifactValidation {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "artifact_unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "artifact_json_invalid" };
  }
  return parseJ9RunArtifact(parsed, hmacSecret, nowMs, options);
}

/** Atomic replace with restricted mode. */
export function saveJ9RunArtifact(path: string, artifact: J9RunArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function assertOwnedResource(
  artifact: J9RunArtifact,
  kind: keyof J9TrackedResources,
  id: string,
): { ok: true } | { ok: false; reason: string } {
  if (!artifact.resources[kind].includes(id)) {
    return { ok: false, reason: `foreign_${kind}_id` };
  }
  return { ok: true };
}

export function emptyTrackedResources(): J9TrackedResources {
  return { customers: [], subscriptions: [], checkoutSessions: [], testClocks: [] };
}
