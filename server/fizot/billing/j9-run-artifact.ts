/**
 * Non-secret J9 live-run artifact. Holds Stripe test resource ids so a manual
 * Checkout can resume the same run. Never stores API keys, webhook secrets,
 * card details or customer content.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const J9_RUN_ARTIFACT_SCHEMA = 1 as const;

export type J9RunStage =
  | "awaiting_checkout"
  | "ready_to_resume"
  | "completed"
  | "abandoned";

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
  workspaceId: string;
  priceHome: string;
  priceTeam: string;
  /** Random nonce for resource MAC. Not a Stripe secret. */
  runNonce: string;
  /** HMAC-SHA256 hex over the canonical resource list. */
  resourceMac: string;
  pauseCleanup: boolean;
  checkout: {
    customerId: string;
    sessionId: string;
    expectedPriceId: string;
  };
  clock: {
    clockId: string;
    frozenTime: number;
    customerId: string;
    subscriptionId: string | null;
    baselineInvoiceId: string | null;
  };
  resources: J9TrackedResources;
};

export type ArtifactValidation =
  | { ok: true; artifact: J9RunArtifact }
  | { ok: false; reason: string };

function requireId(value: unknown, prefix: string): string | null {
  return typeof value === "string" && value.startsWith(prefix) ? value : null;
}

export function createRunId(): string {
  return `j9run_${randomBytes(12).toString("hex")}`;
}

export function createRunNonce(): string {
  return randomBytes(24).toString("hex");
}

export function canonicalResourceList(resources: J9TrackedResources): string {
  const parts = [
    ...resources.testClocks.map((id) => `clock:${id}`),
    ...resources.customers.map((id) => `cus:${id}`),
    ...resources.subscriptions.map((id) => `sub:${id}`),
    ...resources.checkoutSessions.map((id) => `cs:${id}`),
  ];
  return parts.sort().join("|");
}

export function computeResourceMac(runNonce: string, resources: J9TrackedResources): string {
  return createHmac("sha256", runNonce).update(canonicalResourceList(resources)).digest("hex");
}

export function verifyResourceMac(artifact: J9RunArtifact): boolean {
  const expected = computeResourceMac(artifact.runNonce, artifact.resources);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(artifact.resourceMac, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function sealArtifact(
  input: Omit<J9RunArtifact, "resourceMac" | "updatedAt"> & { updatedAt?: string },
): J9RunArtifact {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const base = { ...input, updatedAt };
  return {
    ...base,
    resourceMac: computeResourceMac(base.runNonce, base.resources),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseJ9RunArtifact(raw: unknown): ArtifactValidation {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "artifact_not_object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== J9_RUN_ARTIFACT_SCHEMA) {
    return { ok: false, reason: "artifact_schema_mismatch" };
  }
  if (obj.kind !== "live_j9_run") {
    return { ok: false, reason: "artifact_kind_invalid" };
  }
  const runId = typeof obj.runId === "string" && obj.runId.startsWith("j9run_") ? obj.runId : null;
  if (!runId) return { ok: false, reason: "artifact_run_id_invalid" };
  const stage = obj.stage;
  if (
    stage !== "awaiting_checkout"
    && stage !== "ready_to_resume"
    && stage !== "completed"
    && stage !== "abandoned"
  ) {
    return { ok: false, reason: "artifact_stage_invalid" };
  }
  if (typeof obj.runNonce !== "string" || obj.runNonce.length < 32) {
    return { ok: false, reason: "artifact_run_nonce_invalid" };
  }
  if (typeof obj.resourceMac !== "string" || obj.resourceMac.length !== 64) {
    return { ok: false, reason: "artifact_resource_mac_invalid" };
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
  if (typeof obj.createdAt !== "string" || typeof obj.updatedAt !== "string") {
    return { ok: false, reason: "artifact_timestamps_invalid" };
  }
  if (typeof obj.pauseCleanup !== "boolean") {
    return { ok: false, reason: "artifact_pause_cleanup_invalid" };
  }
  const checkout = obj.checkout as Record<string, unknown> | undefined;
  const clock = obj.clock as Record<string, unknown> | undefined;
  const resources = obj.resources as Record<string, unknown> | undefined;
  if (!checkout || !clock || !resources) {
    return { ok: false, reason: "artifact_sections_missing" };
  }
  const customerId = requireId(checkout.customerId, "cus_");
  const sessionId = requireId(checkout.sessionId, "cs_");
  const expectedPriceId = requireId(checkout.expectedPriceId, "price_");
  if (!customerId || !sessionId || !expectedPriceId) {
    return { ok: false, reason: "artifact_checkout_ids_invalid" };
  }
  const clockId = requireId(clock.clockId, "clock_");
  const clockCustomerId = requireId(clock.customerId, "cus_");
  if (!clockId || !clockCustomerId || typeof clock.frozenTime !== "number") {
    return { ok: false, reason: "artifact_clock_ids_invalid" };
  }
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
    stage,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    workspaceId: obj.workspaceId,
    priceHome: obj.priceHome,
    priceTeam: obj.priceTeam,
    runNonce: obj.runNonce,
    resourceMac: obj.resourceMac,
    pauseCleanup: obj.pauseCleanup,
    checkout: { customerId, sessionId, expectedPriceId },
    clock: {
      clockId,
      frozenTime: clock.frozenTime,
      customerId: clockCustomerId,
      subscriptionId: clock.subscriptionId == null ? null : requireId(clock.subscriptionId, "sub_"),
      baselineInvoiceId: clock.baselineInvoiceId == null ? null : requireId(clock.baselineInvoiceId, "in_"),
    },
    resources: {
      customers: resources.customers,
      subscriptions: resources.subscriptions,
      checkoutSessions: resources.checkoutSessions,
      testClocks: resources.testClocks,
    },
  };
  if (artifact.clock.subscriptionId === null && clock.subscriptionId != null) {
    return { ok: false, reason: "artifact_clock_subscription_invalid" };
  }
  if (artifact.clock.baselineInvoiceId === null && clock.baselineInvoiceId != null) {
    return { ok: false, reason: "artifact_clock_invoice_invalid" };
  }
  if (!verifyResourceMac(artifact)) {
    return { ok: false, reason: "artifact_resource_mac_mismatch" };
  }
  if (!artifact.resources.customers.includes(artifact.checkout.customerId)) {
    return { ok: false, reason: "artifact_checkout_customer_untracked" };
  }
  if (!artifact.resources.customers.includes(artifact.clock.customerId)) {
    return { ok: false, reason: "artifact_clock_customer_untracked" };
  }
  if (!artifact.resources.checkoutSessions.includes(artifact.checkout.sessionId)) {
    return { ok: false, reason: "artifact_session_untracked" };
  }
  if (!artifact.resources.testClocks.includes(artifact.clock.clockId)) {
    return { ok: false, reason: "artifact_clock_untracked" };
  }
  return { ok: true, artifact };
}

export function loadJ9RunArtifact(path: string): ArtifactValidation {
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
  return parseJ9RunArtifact(parsed);
}

export function saveJ9RunArtifact(path: string, artifact: J9RunArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Reject foreign-run resource ids that are not listed in the sealed artifact. */
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
