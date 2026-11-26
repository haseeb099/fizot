import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  assertAgeCleanupSafe,
  assertDisposableStagingAppName,
  createEmptyRunManifest,
  evaluateStagingPreflight,
  isolationAcceptanceOk,
  parseRunManifest,
  readRunManifestFile,
  recordCreatedApp,
  resolveCleanupMode,
  selectRunScopedDestroyTargets,
  stagingConcurrencyGroup,
  StagingSafetyError,
  writeRunManifestFile,
} from "../../../server/fizot/admin/staging-safety.ts";

it("records only disposable fizot-cm-* apps on the run manifest", () => {
  let manifest = createEmptyRunManifest({ flyOrg: "fizot", mode: "isolation" });
  manifest = recordCreatedApp(manifest, "fizot-cm-aaaa");
  manifest = recordCreatedApp(manifest, "fizot-cm-bbbb");
  manifest = recordCreatedApp(manifest, "fizot-cm-aaaa");
  expect(manifest.appNames).toEqual(["fizot-cm-aaaa", "fizot-cm-bbbb"]);
  expect(() => recordCreatedApp(manifest, "fizot-home-image")).toThrow(StagingSafetyError);
  expect(() => recordCreatedApp(manifest, "customer-prod-app")).toThrow(StagingSafetyError);
  expect(() => assertDisposableStagingAppName("fizot-cm-")).toThrow(StagingSafetyError);
});

it("run-scoped cleanup destroys only manifest apps that exist in the org", () => {
  const manifest = recordCreatedApp(
    recordCreatedApp(createEmptyRunManifest({ flyOrg: "fizot", mode: "home" }), "fizot-cm-a"),
    "fizot-cm-b",
  );
  const selected = selectRunScopedDestroyTargets({
    manifest,
    expectedOrg: "fizot",
    existingAppNames: ["fizot-cm-a", "fizot-home-image", "fizot-cm-other"],
  });
  expect(selected.destroy).toEqual(["fizot-cm-a"]);
  expect(selected.skippedMissing).toEqual(["fizot-cm-b"]);
  expect(selected.refused).toEqual([]);
});

it("run-scoped cleanup refuses org mismatch and never expands to all fizot-cm-*", () => {
  const manifest = recordCreatedApp(
    createEmptyRunManifest({ flyOrg: "fizot", mode: "isolation" }),
    "fizot-cm-a",
  );
  expect(() =>
    selectRunScopedDestroyTargets({
      manifest,
      expectedOrg: "other-org",
      existingAppNames: ["fizot-cm-a", "fizot-cm-b"],
    }),
  ).toThrow(/does not match/);
  const selected = selectRunScopedDestroyTargets({
    manifest,
    expectedOrg: "fizot",
    existingAppNames: ["fizot-cm-a", "fizot-cm-b", "fizot-cm-c"],
  });
  expect(selected.destroy).toEqual(["fizot-cm-a"]);
  expect(selected.destroy).not.toContain("fizot-cm-b");
});

it("partial provisioning: missing apps are skipped, present ones still destroy", () => {
  const manifest = {
    ...createEmptyRunManifest({ flyOrg: "fizot", mode: "isolation" }),
    appNames: ["fizot-cm-ok", "fizot-cm-gone"],
  };
  const selected = selectRunScopedDestroyTargets({
    manifest,
    expectedOrg: "fizot",
    existingAppNames: ["fizot-cm-ok"],
  });
  expect(selected.destroy).toEqual(["fizot-cm-ok"]);
  expect(selected.skippedMissing).toEqual(["fizot-cm-gone"]);
});

it("age cleanup refuses MAX_AGE_MS=0 without explicit dangerous allow", () => {
  expect(() => assertAgeCleanupSafe({ mode: "age", maxAgeMs: 0 })).toThrow(/run-scoped/);
  expect(() => assertAgeCleanupSafe({ mode: "age", maxAgeMs: 0, allowAgeZero: true })).not.toThrow();
  expect(() => assertAgeCleanupSafe({ mode: "age", maxAgeMs: 24 * 60 * 60 * 1000 })).not.toThrow();
  expect(() => assertAgeCleanupSafe({ mode: "run-scoped", maxAgeMs: 0 })).not.toThrow();
});

it("preflight fails closed on unexpected or production-looking apps", () => {
  const clean = evaluateStagingPreflight({
    org: "fizot",
    mode: "isolation",
    apps: [{ name: "fizot-home-image" }],
  });
  expect(clean.ok).toBe(true);
  if (clean.ok) expect(clean.imagePresent).toBe(true);

  const dirty = evaluateStagingPreflight({
    org: "fizot",
    mode: "isolation",
    apps: [{ name: "fizot-home-image" }, { name: "customer-api" }],
  });
  expect(dirty.ok).toBe(false);
  if (!dirty.ok) expect(dirty.reasons.some((r) => r.includes("customer-api"))).toBe(true);

  const leftover = evaluateStagingPreflight({
    org: "fizot",
    mode: "isolation",
    apps: [{ name: "fizot-home-image" }, { name: "fizot-cm-leftover" }],
  });
  expect(leftover.ok).toBe(false);

  const homeOkWithOrphan = evaluateStagingPreflight({
    org: "fizot",
    mode: "home",
    apps: [{ name: "fizot-home-image" }, { name: "fizot-cm-leftover" }],
  });
  expect(homeOkWithOrphan.ok).toBe(true);

  const prodOrg = evaluateStagingPreflight({
    org: "customer-prod",
    apps: [],
    productionOrgs: ["customer-prod"],
  });
  expect(prodOrg.ok).toBe(false);
});

it("preflight allows missing image app (workflow may create it) but still fails on strangers", () => {
  const missingImage = evaluateStagingPreflight({
    org: "fizot",
    mode: "home",
    apps: [],
  });
  expect(missingImage.ok).toBe(true);
  if (missingImage.ok) expect(missingImage.imagePresent).toBe(false);
});

it("persists and reloads the run manifest", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fizot-manifest-"));
  try {
    const file = path.join(dir, "run-manifest.json");
    let manifest = createEmptyRunManifest({
      flyOrg: "fizot",
      mode: "isolation",
      workflowRunId: "123",
    });
    manifest = recordCreatedApp(manifest, "fizot-cm-one");
    writeRunManifestFile(file, manifest);
    const loaded = readRunManifestFile(file);
    expect(loaded.appNames).toEqual(["fizot-cm-one"]);
    expect(loaded.workflowRunId).toBe("123");
    expect(parseRunManifest(JSON.parse(readFileSync(file, "utf8"))).flyOrg).toBe("fizot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("cleanup mode resolution and concurrency group", () => {
  expect(resolveCleanupMode({ FLY_STAGING_CLEANUP_MODE: "run-scoped" })).toBe("run-scoped");
  expect(resolveCleanupMode({ FLY_STAGING_CLEANUP_MODE: "age" })).toBe("age");
  expect(resolveCleanupMode({})).toBe("age");
  expect(() => resolveCleanupMode({ FLY_STAGING_CLEANUP_MODE: "all" })).toThrow(StagingSafetyError);
  expect(stagingConcurrencyGroup("fizot")).toBe("fizot-fly-staging-fizot");
});

it("failed cleanup cannot count as isolation acceptance", () => {
  expect(isolationAcceptanceOk({ probeOverall: "PASS", cleanupOutcome: "ok" })).toBe(true);
  expect(isolationAcceptanceOk({ probeOverall: "PASS", cleanupOutcome: "partial-failure" })).toBe(false);
  expect(isolationAcceptanceOk({ probeOverall: "PASS", cleanupOutcome: "error" })).toBe(false);
  expect(isolationAcceptanceOk({ probeOverall: "FAIL", cleanupOutcome: "ok" })).toBe(false);
  expect(isolationAcceptanceOk({ probeOverall: "INCONCLUSIVE", cleanupOutcome: "ok" })).toBe(false);
});

it("invalid manifest app names are refused at parse time", () => {
  expect(() =>
    parseRunManifest({
      schemaVersion: 1,
      flyOrg: "fizot",
      workflowRunId: null,
      mode: "isolation",
      createdAt: "",
      updatedAt: "",
      imageApp: "fizot-home-image",
      appNames: ["not-staging"],
    }),
  ).toThrow(StagingSafetyError);
});
