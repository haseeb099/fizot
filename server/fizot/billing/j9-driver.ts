import { signStripeHeader, verifyStripeSignature, deliverWebhookEvent, createMemoryWebhookEventStore } from "../admin/webhooks.ts";
import { createMemoryCreditStore } from "../proxy/credit-store.ts";
import { createBillingService, type StripeEvent } from "./apply.ts";
import { createFakeEmailProvider } from "./email.ts";
import { resolveJ9Config, redactSecrets } from "./j9-config.ts";
import {
  cleanupAbandonedRun,
  cleanupTrackedResources,
  persistRetainedLifecycle,
  prepareLiveJ9,
  resumeLiveCheckoutEvidence,
} from "./j9-live-stages.ts";
import {
  createFakeStripeTransport,
  createLiveStripeTransport,
  type FakeStripeTransport,
  type J9StripeTransport,
} from "./j9-transport.ts";
import { createFakeBillingProvider } from "./provider.ts";
import { emptyRecord } from "./record.ts";
import { createMemoryBillingStore } from "./store.ts";
import { persistArtifactUpdate, type J9RunArtifact, type J9TrackedResources } from "./j9-run-artifact.ts";
import {
  runCheckoutCompleted,
  runCheckoutSessionCreated,
  runCheckoutSubscriptionPaymentAndCredit,
  runSimulatedFailedPayment,
  runSimulatedRecovery,
  runStripeDunning,
  runSubscriptionPaymentAndCredit,
  runTaxAndSeats,
  runWebhookLifecycle,
} from "./j9-scenario-runners.ts";
import type { J9EventSource, J9Kind, J9Report, J9ScenarioResult, J9ScenarioStatus } from "./j9-types.ts";

export type { J9EventSource, J9Kind, J9Report, J9ScenarioResult, J9ScenarioStatus } from "./j9-types.ts";
export { formatJ9Report } from "./j9-types.ts";

const SHARED_MANDATORY = [
  "secure_startup",
  "checkout_session_created",
  "checkout_completed",
  "subscription_payment_and_credit",
  "webhook_lifecycle",
  "simulated_failed_payment_lifecycle",
  "simulated_recovery",
  "tax_and_seats",
  "cleanup",
] as const;

const LIVE_ONLY_MANDATORY = ["stripe_dunning_recovery"] as const;

function mandatoryFor(kind: J9Kind): readonly string[] {
  return kind === "live_j9" ? [...SHARED_MANDATORY, ...LIVE_ONLY_MANDATORY] : SHARED_MANDATORY;
}

function verificationIncomplete(scenarios: J9ScenarioResult[], kind: J9Kind): boolean {
  const required = mandatoryFor(kind).filter((name) => name !== "cleanup");
  return required.some((name) => {
    const row = scenarios.find((item) => item.scenario === name);
    return !row || row.status !== "PASS";
  });
}

function scenario(name: string, status: J9ScenarioStatus, source: J9EventSource, evidence: string, extra: Partial<J9ScenarioResult> = {}): J9ScenarioResult {
  return { scenario: name, status, source, evidence, ...extra };
}

export function finish(input: {
  kind: J9Kind;
  scenarios: J9ScenarioResult[];
  resources: J9Report["resources"];
  artifactPath?: string | null;
  runId?: string | null;
  checkoutUrl?: string | null;
}): J9Report {
  const required = mandatoryFor(input.kind);
  const byName = new Map(input.scenarios.map((row) => [row.scenario, row]));
  const ordered = [
    ...required.map((name) => byName.get(name) ?? scenario(name, "NOT_RUN", "none", "not executed")),
    ...input.scenarios.filter((row) => !required.includes(row.scenario)),
  ];
  // Deduplicate while preferring required order.
  const seen = new Set<string>();
  const scenarios = ordered.filter((row) => {
    if (seen.has(row.scenario)) return false;
    seen.add(row.scenario);
    return true;
  });
  const requiredRows = scenarios.filter((row) => required.includes(row.scenario));
  const hasFail = requiredRows.some((row) => row.status === "FAIL");
  const hasBlockedOrSkip = requiredRows.some((row) => row.status === "BLOCKED" || row.status === "NOT_RUN");
  const overall = hasFail ? "FAIL" : hasBlockedOrSkip ? "BLOCKED" : "PASS";
  const exitCode = overall === "PASS" ? 0 : overall === "FAIL" ? 1 : 2;
  return {
    kind: input.kind,
    liveAcceptance: input.kind === "live_j9" && overall === "PASS",
    overall,
    exitCode,
    scenarios,
    resources: {
      customers: input.resources.customers,
      subscriptions: input.resources.subscriptions,
      checkoutSessions: input.resources.checkoutSessions,
      testClocks: input.resources.testClocks ?? [],
    },
    artifactPath: input.artifactPath ?? null,
    runId: input.runId ?? null,
    checkoutUrl: input.checkoutUrl ?? null,
  };
}

function emptyResources(): J9TrackedResources {
  return { customers: [], subscriptions: [], checkoutSessions: [], testClocks: [] };
}

function signedBody(secret: string, event: StripeEvent): { body: string; header: string } {
  const body = JSON.stringify(event);
  const header = signStripeHeader(secret, body, event.created);
  return { body, header };
}

function isFakeTransport(transport: J9StripeTransport): transport is FakeStripeTransport {
  return typeof (transport as FakeStripeTransport).markCheckoutComplete === "function";
}

export type J9DriverDeps = {
  env: NodeJS.ProcessEnv;
  transport?: J9StripeTransport;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Override repo root for fixed artifacts/j9 paths (tests). */
  repoRoot?: string;
};

/**
 * Isolated J9 verification. Fake-unit PASS is never live acceptance.
 * Live J9 PASS requires every live mandatory scenario, including hosted checkout completion
 * and Stripe dunning coverage.
 */
export async function runJ9(deps: J9DriverDeps): Promise<J9Report> {
  const log = deps.log ?? (() => {});
  const scenarios: J9ScenarioResult[] = [];
  const resources = emptyResources();
  const resolved = resolveJ9Config(deps.env, deps.repoRoot ?? process.cwd());
  const kind: J9Kind = (resolved.ok ? resolved.config.transport : "live") === "fake" ? "fake_unit" : "live_j9";

  if (!resolved.ok) {
    scenarios.push(scenario("secure_startup", resolved.status, "config", resolved.reason, { failureReason: resolved.reason }));
    for (const name of mandatoryFor(kind)) {
      if (name === "secure_startup") continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by secure_startup"));
    }
    return finish({ kind, scenarios, resources });
  }

  const config = resolved.config;
  if (config.transport === "live" && deps.transport && isFakeTransport(deps.transport) && config.stage === "full") {
    // Stage prepare/resume/cleanup unit tests inject a fake transport under live config on purpose.
    scenarios.push(scenario("secure_startup", "FAIL", "config", "live config with fake transport injected", {
      failureReason: "refusing fake transport under live J9 config",
    }));
    for (const name of mandatoryFor("live_j9")) {
      if (name === "secure_startup") continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by secure_startup"));
    }
    return finish({ kind: "live_j9", scenarios, resources });
  }

  const secrets = [config.apiKey, config.webhookSecret, config.artifactHmacSecret];
  const safeLog = (line: string) => log(redactSecrets(line, secrets));
  const transport = deps.transport
    ?? (config.transport === "fake"
      ? createFakeStripeTransport()
      : createLiveStripeTransport(config.apiKey, deps.fetchImpl));

  if (config.stage === "cleanup") {
    const abandoned = await cleanupAbandonedRun({ config, transport });
    return finish({
      kind,
      scenarios: [
        scenario("secure_startup", "PASS", "config", `stage=cleanup confirm=${config.cleanupConfirm}`),
        ...abandoned.scenarios,
      ],
      resources: abandoned.resources,
      artifactPath: config.artifactPath,
      runId: config.cleanupConfirm,
    });
  }

  if (config.stage === "prepare") {
    const prepared = await prepareLiveJ9({ config, transport });
    for (const row of prepared.scenarios) scenarios.push(row);
    for (const name of mandatoryFor(kind)) {
      if (scenarios.some((row) => row.scenario === name)) continue;
      scenarios.push(scenario(name, "NOT_RUN", "none", "awaiting_resume_after_manual_checkout"));
    }
    scenarios.push(await cleanupTrackedResources({
      transport,
      resources: prepared.resources,
      secrets,
      pauseCleanup: prepared.artifact.pauseCleanup,
      artifact: prepared.artifact,
      hmacSecret: config.artifactHmacSecret,
      artifactPath: config.artifactPath,
    }));
    if (prepared.checkoutUrl) safeLog(`j9_prepare checkout_url=${prepared.checkoutUrl} artifact=${config.artifactPath}`);
    return finish({
      kind: "live_j9",
      scenarios,
      resources: prepared.resources,
      artifactPath: config.artifactPath,
      runId: prepared.artifact.runId,
      checkoutUrl: prepared.checkoutUrl,
    });
  }

  let liveArtifact: J9RunArtifact | null = null;
  let resumeCheckoutSub: string | null = null;
  let resumeCheckoutInvoice: string | null = null;
  let webhookFromCapture = false;

  if (config.stage === "resume") {
    const resumed = await resumeLiveCheckoutEvidence({ config, transport });
    if (!resumed.ok) {
      for (const row of resumed.scenarios) scenarios.push(row);
      for (const name of mandatoryFor(kind)) {
        if (scenarios.some((row) => row.scenario === name)) continue;
        scenarios.push(scenario(name, "NOT_RUN", "none", "blocked by resume"));
      }
      const retained = resumed.resources;
      scenarios.push(await cleanupTrackedResources({
        transport,
        resources: retained,
        secrets,
        pauseCleanup: true,
        artifact: resumed.artifact,
        hmacSecret: config.artifactHmacSecret,
        artifactPath: config.artifactPath,
      }));
      return finish({
        kind: "live_j9",
        scenarios,
        resources: retained,
        artifactPath: config.artifactPath,
        runId: resumed.artifact?.runId ?? null,
      });
    }
    for (const row of resumed.evidence.scenarios) scenarios.push(row);
    Object.assign(resources, resumed.evidence.resources);
    liveArtifact = resumed.evidence.artifact;
    resumeCheckoutSub = resumed.evidence.checkoutSubscriptionId;
    resumeCheckoutInvoice = resumed.evidence.checkoutInvoiceId;
    webhookFromCapture = resumed.evidence.webhookCaptureOk;
  } else {
    scenarios.push(scenario(
      "secure_startup",
      "PASS",
      "config",
      `kind=${kind} mode=test transport=${config.transport} stage=${config.stage} key_prefix=sk_test_ price=configured`,
    ));
  }

  const credit = createMemoryCreditStore();
  const store = createMemoryBillingStore();
  const email = createFakeEmailProvider();
  const provider = createFakeBillingProvider();
  const deletes: string[] = [];
  const resumes: string[] = [];
  const billing = createBillingService({
    store,
    credit,
    provider,
    email,
    urls: { successUrl: config.successUrl, cancelUrl: config.cancelUrl, portalReturnUrl: config.portalReturnUrl },
    ownerEmail: async () => "j9-owner@example.invalid",
    onSuspend: async () => {},
    onResume: async (id) => { resumes.push(id); },
    onDelete: async (id) => { deletes.push(id); },
  });
  const webhookStore = createMemoryWebhookEventStore();
  const workspaceId = liveArtifact?.workspaceId ?? `ws_j9_${Date.now().toString(36)}`;
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const nextCreatedSec = () => {
    clock += 1000;
    return Math.floor(clock / 1000);
  };

  const applySignedFixture = async (event: StripeEvent) => {
    const { body, header } = signedBody(config.webhookSecret, event);
    const verified = verifyStripeSignature({ secret: config.webhookSecret, body, header, now: () => event.created * 1000 });
    if (!verified.ok) throw new Error(`signature_${verified.error}`);
    return deliverWebhookEvent({
      store: webhookStore,
      provider: "stripe",
      eventId: event.id,
      handler: () => billing.applyEvent(event),
      now: () => event.created * 1000,
    });
  };

  try {
    if (config.stage !== "resume") {
      scenarios.push(await runCheckoutSessionCreated(config, transport, resources, workspaceId, billing));
      scenarios.push(await runCheckoutCompleted(kind, transport, resources));
      scenarios.push(await runSubscriptionPaymentAndCredit({
        config, transport, resources, workspaceId, credit, billing, applySignedFixture, createdSec: nextCreatedSec, safeLog,
      }));
    } else if (resumeCheckoutSub && resumeCheckoutInvoice && liveArtifact) {
      const record = (await billing.store.get(workspaceId)) ?? emptyRecord(workspaceId);
      record.stripeCustomerId = liveArtifact.checkout.customerId;
      record.plan = "home";
      record.country = "GB";
      await billing.store.save(record);
      const creditResult = await runCheckoutSubscriptionPaymentAndCredit({
        config,
        transport,
        workspaceId,
        customerId: liveArtifact.checkout.customerId,
        subscriptionId: resumeCheckoutSub,
        invoiceId: resumeCheckoutInvoice,
        alreadyGrantedInvoiceId: liveArtifact.checkout.creditInvoiceId,
        credit,
        billing,
        applySignedFixture,
        createdSec: nextCreatedSec,
        safeLog,
      });
      scenarios.push(creditResult.scenario);
      if (creditResult.grantedInvoiceId && liveArtifact.checkout.creditInvoiceId !== creditResult.grantedInvoiceId) {
        liveArtifact = persistArtifactUpdate(config.artifactHmacSecret, config.artifactPath, liveArtifact, {
          checkout: {
            ...liveArtifact.checkout,
            creditInvoiceId: creditResult.grantedInvoiceId,
          },
        });
      }
    } else {
      scenarios.push(scenario("subscription_payment_and_credit", "FAIL", "none", "checkout subscription missing on resume", {
        failureReason: "checkout_subscription_required",
      }));
    }
    if (!(config.stage === "resume" && webhookFromCapture)) {
      scenarios.push(await runWebhookLifecycle({
        config, workspaceId, billing, credit, createdSec: nextCreatedSec, kind,
      }));
    }
    scenarios.push(await runSimulatedFailedPayment({
      workspaceId, billing, applySignedFixture, createdSec: nextCreatedSec, email, deletes,
      now: () => clock,
      advance: async (ms) => {
        clock += ms;
        return billing.tick(clock);
      },
    }));
    scenarios.push(await runSimulatedRecovery({
      workspaceId, billing, applySignedFixture, createdSec: nextCreatedSec, credit, resumes,
    }));
    const dunning = await runStripeDunning({
      kind,
      transport,
      artifact: liveArtifact,
      hmacSecret: config.artifactHmacSecret,
      artifactPath: config.artifactPath,
      sleepMs: config.transport === "live" ? 250 : 0,
    });
    scenarios.push(dunning.scenario);
    if (dunning.artifact) liveArtifact = dunning.artifact;
    scenarios.push(await runTaxAndSeats({ config, transport, resources }));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    safeLog(`j9_error ${message}`);
    for (const name of mandatoryFor(kind)) {
      if (scenarios.some((row) => row.scenario === name)) continue;
      scenarios.push(scenario(name, "FAIL", "none", "aborted", { failureReason: message }));
    }
  } finally {
    const stagedLiveResume = kind === "live_j9" && config.stage === "resume";
    const incomplete = stagedLiveResume && verificationIncomplete(scenarios, kind);
    if (incomplete && liveArtifact) {
      const hasFail = scenarios.some((row) =>
        mandatoryFor(kind).includes(row.scenario) && row.scenario !== "cleanup" && row.status === "FAIL",
      );
      const retained = persistRetainedLifecycle({
        hmacSecret: config.artifactHmacSecret,
        artifactPath: config.artifactPath,
        artifact: liveArtifact,
        to: hasFail ? "retryable_failure" : "awaiting_evidence",
        reason: hasFail ? "resume_incomplete_fail_retain" : "resume_incomplete_blocked_retain",
        resources,
      });
      liveArtifact = retained;
      scenarios.push(await cleanupTrackedResources({
        transport,
        resources,
        secrets,
        pauseCleanup: true,
        artifact: retained,
        hmacSecret: config.artifactHmacSecret,
        artifactPath: config.artifactPath,
        retainReason: `stage=${retained.stage} retry_safe=${retained.retrySafe} resources_retained_for_retry`,
      }));
    } else if (incomplete && config.stage === "resume") {
      scenarios.push(scenario("cleanup", "BLOCKED", "config", "incomplete_resume_without_artifact", {
        failureReason: "Cannot auto-delete; recover the latest uploaded j9-run-artifact and run confirmed cleanup",
        cleanup: "retained",
      }));
    } else {
      scenarios.push(await cleanupTrackedResources({
        transport,
        resources,
        secrets,
        pauseCleanup: false,
        artifact: liveArtifact,
        hmacSecret: config.artifactHmacSecret,
        artifactPath: config.artifactPath,
        markCompleted: kind === "live_j9" && config.stage === "resume",
      }));
    }
    await billing.close();
  }

  return finish({
    kind,
    scenarios,
    resources,
    artifactPath: config.artifactPath,
    runId: liveArtifact?.runId ?? null,
  });
}

