import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  buildCostSheet,
  FLY_ADDITIONAL_RAM_USD_PER_GB_MONTH,
  FLY_SHARED_CPU_1X_1GB_USD_PER_MONTH,
  FLY_VOLUME_USD_PER_GB_MONTH,
  priceFloorGbp,
  profileCost,
  sharedCpu1xWithRamUsdPerMonth,
  USAGE_PROFILES,
} from "../../server/fizot/cost-sheet.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = path.join(ROOT, "tests/fizot/fixtures/s2-10");
const ARTIFACTS = path.join(ROOT, "artifacts/s2-10");

function loadJson(dir: string, prefix: string) {
  const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".json"));
  if (!name) throw new Error(`missing ${prefix}*.json in ${dir}`);
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

it("prices shared-cpu-1x 2GB as 1GB preset plus 1GB additional RAM", () => {
  expect(sharedCpu1xWithRamUsdPerMonth(2)).toBe(
    FLY_SHARED_CPU_1X_1GB_USD_PER_MONTH + FLY_ADDITIONAL_RAM_USD_PER_GB_MONTH,
  );
  expect(sharedCpu1xWithRamUsdPerMonth(2)).toBe(12.7);
});

it("computes the three usage profiles from fixture probe numbers", () => {
  const awake = loadJson(FIXTURES, "awake-");
  const asleep = loadJson(FIXTURES, "asleep-");
  const sheet = buildCostSheet({
    awake,
    asleep,
    sourceRun: "fixture",
    assumptions: { egressGbPerMonth: 5, rootfsGb: 3, monthDays: 30, usdPerGbp: 1.3 },
  });

  expect(sheet.measured.awakeMachineSeconds).toBe(26.541);
  expect(sheet.measured.asleepMachineSeconds).toBe(16.101);
  expect(sheet.measured.volumeGb).toBe(10);
  expect(sheet.measured.egressBytes).toBeNull();

  const always = sheet.profiles.find((p) => p.id === "always_on")!;
  const eight = sheet.profiles.find((p) => p.id === "eight_hours_day")!;
  const one = sheet.profiles.find((p) => p.id === "one_hour_day")!;

  expect(always.volumeUsd).toBe(10 * FLY_VOLUME_USD_PER_GB_MONTH);
  expect(always.machineRunningUsd).toBe(12.7);
  expect(always.stoppedRootfsUsd).toBe(0);
  expect(always.egressUsd).toBe(0.1);
  expect(always.totalUsd).toBe(14.3);

  expect(eight.awakeFraction).toBeCloseTo(8 / 24, 6);
  expect(eight.machineRunningUsd).toBe(4.2333);
  expect(eight.stoppedRootfsUsd).toBe(0.3);
  expect(eight.totalUsd).toBe(6.1333);

  expect(one.awakeFraction).toBeCloseTo(1 / 24, 6);
  expect(one.machineRunningUsd).toBe(0.5292);
  expect(one.stoppedRootfsUsd).toBe(0.4313);
  expect(one.totalUsd).toBe(2.5605);

  expect(priceFloorGbp(always.totalUsd)).toBe(19.3772);
});

it("profileCost matches USAGE_PROFILES arithmetic independently", () => {
  const assumptions = { egressGbPerMonth: 5, rootfsGb: 3, monthDays: 30, usdPerGbp: 1.3 };
  for (const profile of USAGE_PROFILES) {
    const row = profileCost(profile, 10, assumptions);
    const awake = profile.awakeHoursPerDay / 24;
    expect(row.machineRunningUsd).toBe(Math.round(12.7 * awake * 10_000) / 10_000);
    expect(row.volumeUsd).toBe(1.5);
    expect(row.egressUsd).toBe(0.1);
  }
});

it("CS-I: builds the sheet from the real staging probe artifacts", () => {
  const awake = loadJson(ARTIFACTS, "awake-");
  const asleep = loadJson(ARTIFACTS, "asleep-");
  expect(awake.machineSeconds).toBeGreaterThan(0);
  expect(awake.volumeGb).toBe(10);
  expect(awake.egressBytes).toBeNull();
  // True stopped sample: wall ≥ 60 s, billable ~0. Older 409 samples stay started.
  if (asleep.machineState === "stopped" || asleep.machineState === "suspended") {
    expect(asleep.sampleWallSeconds ?? 0).toBeGreaterThanOrEqual(55);
    expect(asleep.machineSeconds).toBeLessThan(5);
  } else {
    expect(asleep.machineSeconds).toBeGreaterThan(0);
  }
  const sheet = buildCostSheet({
    awake,
    asleep,
    sourceRun: awake.recordedAt ?? "artifacts/s2-10",
  });
  expect(sheet.profiles).toHaveLength(3);
  expect(sheet.profiles.every((p) => p.totalUsd > 0)).toBe(true);
  expect(sheet.measured.awakeMachineSeconds).toBe(awake.machineSeconds);
  expect(sheet.measured.asleepMachineSeconds).toBe(asleep.machineSeconds);
});
