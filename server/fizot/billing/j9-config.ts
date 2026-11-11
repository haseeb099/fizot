/**
 * J9 runs only in an explicitly selected Stripe test mode with a test key
 * and an explicitly configured test Price id. Live keys and unpublished
 * placeholder Price ids are refused.
 */
import {
  assertArtifactHmacSecret,
  J9_FIXED_ARTIFACT_RELATIVE,
  J9_FIXED_CAPTURE_RELATIVE,
  resolveSafeJ9Path,
} from "./j9-run-artifact.ts";

export type J9Stage = "full" | "prepare" | "resume" | "cleanup";

export type J9Config = {
  apiKey: string;
  webhookSecret: string;
  /** Independent HMAC secret for run artifacts. Never written into artifacts. */
  artifactHmacSecret: string;
  priceHome: string;
  priceTeam: string;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
  transport: "live" | "fake";
  stage: J9Stage;
  artifactPath: string;
  webhookCapturePath: string;
  cleanupConfirm: string | null;
  /**
   * GitHub Actions run id that uploaded the *latest* j9-run-artifact (digits).
   * After a blocked resume this must be the resume run, not the original prepare.
   */
  artifactRunId: string | null;
};

export type J9ConfigError = {
  ok: false;
  status: "FAIL" | "BLOCKED";
  reason: string;
  missing: string[];
};

export type J9ConfigResult = { ok: true; config: J9Config } | J9ConfigError;

const PLACEHOLDER_PRICES = new Set(["price_unpublished_home", "price_unpublished_team"]);

export function resolveJ9Config(env: NodeJS.ProcessEnv, repoRoot = process.cwd()): J9ConfigResult {
  const mode = (env.STRIPE_J9_MODE ?? "").trim().toLowerCase();
  if (mode !== "test") {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "STRIPE_J9_MODE must be exactly 'test'",
      missing: mode ? [] : ["STRIPE_J9_MODE"],
    };
  }

  const apiKey = (env.STRIPE_TEST_API_KEY ?? "").trim();
  const webhookSecret = (env.STRIPE_TEST_WEBHOOK_SECRET ?? "").trim();
  const artifactHmac = assertArtifactHmacSecret(env.STRIPE_J9_ARTIFACT_HMAC_SECRET);
  const priceHome = (env.STRIPE_J9_PRICE_HOME ?? "").trim();
  const priceTeam = (env.STRIPE_J9_PRICE_TEAM ?? priceHome).trim();
  const transport = (env.STRIPE_J9_TRANSPORT ?? "live").trim().toLowerCase() === "fake" ? "fake" : "live";
  const stageRaw = (env.STRIPE_J9_STAGE ?? "full").trim().toLowerCase();
  const stage: J9Stage =
    stageRaw === "prepare" || stageRaw === "resume" || stageRaw === "cleanup" || stageRaw === "full"
      ? stageRaw
      : "full";
  if (stageRaw && stageRaw !== stage) {
    return {
      ok: false,
      status: "FAIL",
      reason: "STRIPE_J9_STAGE must be full|prepare|resume|cleanup",
      missing: [],
    };
  }
  const cleanupConfirm = (env.STRIPE_J9_CLEANUP_CONFIRM ?? "").trim() || null;
  const artifactRunIdRaw = (env.STRIPE_J9_ARTIFACT_RUN_ID ?? env.STRIPE_J9_PREPARE_RUN_ID ?? "").trim();
  const artifactRunId = artifactRunIdRaw && /^\d+$/.test(artifactRunIdRaw) ? artifactRunIdRaw : null;
  if (artifactRunIdRaw && !artifactRunId) {
    return { ok: false, status: "FAIL", reason: "STRIPE_J9_ARTIFACT_RUN_ID must be digits only", missing: [] };
  }

  const artifactResolved = resolveSafeJ9Path(repoRoot, J9_FIXED_ARTIFACT_RELATIVE);
  const captureResolved = resolveSafeJ9Path(repoRoot, J9_FIXED_CAPTURE_RELATIVE);
  if (!artifactResolved.ok) {
    return { ok: false, status: "FAIL", reason: artifactResolved.reason, missing: [] };
  }
  if (!captureResolved.ok) {
    return { ok: false, status: "FAIL", reason: captureResolved.reason, missing: [] };
  }

  const missing: string[] = [];
  if (!apiKey) missing.push("STRIPE_TEST_API_KEY");
  if (!webhookSecret) missing.push("STRIPE_TEST_WEBHOOK_SECRET");
  if (!priceHome) missing.push("STRIPE_J9_PRICE_HOME");
  if ((stage === "prepare" || stage === "resume" || stage === "cleanup") && !artifactHmac.ok) {
    missing.push("STRIPE_J9_ARTIFACT_HMAC_SECRET");
  }
  if (stage === "cleanup" && !cleanupConfirm) missing.push("STRIPE_J9_CLEANUP_CONFIRM");
  if (missing.length > 0) {
    return { ok: false, status: "BLOCKED", reason: `missing_secret ${missing.join(" ")}`, missing };
  }

  if (apiKey.startsWith("sk_live_")) {
    return { ok: false, status: "FAIL", reason: "live Stripe key rejected", missing: [] };
  }
  if (!apiKey.startsWith("sk_test_")) {
    return { ok: false, status: "FAIL", reason: "STRIPE_TEST_API_KEY must start with sk_test_", missing: [] };
  }
  if (webhookSecret.startsWith("sk_live_") || webhookSecret.startsWith("sk_test_")) {
    return { ok: false, status: "FAIL", reason: "webhook secret must not be an API key", missing: [] };
  }
  if (!priceHome.startsWith("price_")) {
    return { ok: false, status: "FAIL", reason: "STRIPE_J9_PRICE_HOME must be a Stripe Price id", missing: [] };
  }
  if (transport === "live" && PLACEHOLDER_PRICES.has(priceHome)) {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "STRIPE_J9_PRICE_HOME must be a real Stripe test Price, not price_unpublished_*",
      missing: ["STRIPE_J9_PRICE_HOME"],
    };
  }
  if (transport === "live" && PLACEHOLDER_PRICES.has(priceTeam)) {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "STRIPE_J9_PRICE_TEAM must be a real Stripe test Price, not price_unpublished_*",
      missing: ["STRIPE_J9_PRICE_TEAM"],
    };
  }

  // Full fake_unit may omit HMAC secret; staged live always requires it (checked above).
  const hmacSecret = artifactHmac.ok
    ? artifactHmac.secret
    : "j9_fake_unit_hmac_secret_not_for_live_use_32b";

  return {
    ok: true,
    config: {
      apiKey,
      webhookSecret,
      artifactHmacSecret: hmacSecret,
      priceHome,
      priceTeam: priceTeam || priceHome,
      successUrl: env.FIZOT_BILLING_SUCCESS_URL?.trim() || "https://admin.example.invalid/billing/success",
      cancelUrl: env.FIZOT_BILLING_CANCEL_URL?.trim() || "https://admin.example.invalid/billing/cancel",
      portalReturnUrl: env.FIZOT_BILLING_PORTAL_RETURN_URL?.trim() || "https://admin.example.invalid/billing",
      transport,
      stage,
      artifactPath: artifactResolved.path,
      webhookCapturePath: captureResolved.path,
      cleanupConfirm,
      artifactRunId,
    },
  };
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}
