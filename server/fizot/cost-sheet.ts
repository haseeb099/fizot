/**
 * S2.10 staging cost sheet arithmetic.
 * Measured probe fields vs published Fly rates are kept explicit.
 */

/** Fly pricing page (iad/ewr baseline) as read for this sheet. */
export const FLY_PRICING_URL = "https://fly.io/docs/about/pricing/";
export const FLY_PRICING_READ_DATE = "2026-11-04";

/** shared-cpu-1x 1GB preset at iad, USD / 30-day continuous month. */
export const FLY_SHARED_CPU_1X_1GB_USD_PER_MONTH = 6.7;
/** Additional RAM beyond the CPU preset, USD / GB / month. */
export const FLY_ADDITIONAL_RAM_USD_PER_GB_MONTH = 6.0;
/** Home machine memory for Fizot (shared-cpu-1x + 2 GB). */
export const FIZOT_HOME_MEMORY_GB = 2;
/** Volume rate, USD / GB / month. */
export const FLY_VOLUME_USD_PER_GB_MONTH = 0.15;
/** Stopped Machine rootfs, USD / GB / month. */
export const FLY_STOPPED_ROOTFS_USD_PER_GB_MONTH = 0.15;
/** Outbound egress NA/Europe, USD / GB. */
export const FLY_EGRESS_NA_EU_USD_PER_GB = 0.02;

export const SECONDS_PER_MONTH_30D = 30 * 86_400;

export type ProbeRecord = {
  schema?: string;
  phase: string;
  recordedAt?: string;
  appName?: string;
  machineSeconds: number;
  volumeGb: number;
  egressBytes: number | null;
  machineState?: string;
};

export type CostAssumptions = {
  /** Assumed outbound egress GB per customer per month (not measured). */
  egressGbPerMonth: number;
  /** Assumed stopped-machine rootfs GB (not measured). */
  rootfsGb: number;
  /** Billing month length in days. */
  monthDays: number;
  usdPerGbp: number;
};

export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  egressGbPerMonth: 5,
  rootfsGb: 3,
  monthDays: 30,
  usdPerGbp: 1.3,
};

export type UsageProfileId = "always_on" | "eight_hours_day" | "one_hour_day";

export type UsageProfile = {
  id: UsageProfileId;
  label: string;
  awakeHoursPerDay: number;
};

export const USAGE_PROFILES: UsageProfile[] = [
  { id: "always_on", label: "Always on (24×7)", awakeHoursPerDay: 24 },
  { id: "eight_hours_day", label: "8 h/day awake", awakeHoursPerDay: 8 },
  { id: "one_hour_day", label: "Mostly asleep (1 h/day)", awakeHoursPerDay: 1 },
];

export function sharedCpu1xWithRamUsdPerMonth(memoryGb = FIZOT_HOME_MEMORY_GB): number {
  const additionalGb = Math.max(0, memoryGb - 1);
  return round4(FLY_SHARED_CPU_1X_1GB_USD_PER_MONTH + additionalGb * FLY_ADDITIONAL_RAM_USD_PER_GB_MONTH);
}

export function sharedCpu1xWithRamUsdPerSec(memoryGb = FIZOT_HOME_MEMORY_GB): number {
  return sharedCpu1xWithRamUsdPerMonth(memoryGb) / SECONDS_PER_MONTH_30D;
}

export type ProfileCost = {
  id: UsageProfileId;
  label: string;
  awakeHoursPerDay: number;
  awakeFraction: number;
  machineRunningUsd: number;
  stoppedRootfsUsd: number;
  volumeUsd: number;
  egressUsd: number;
  totalUsd: number;
  totalGbp: number;
};

export type CostSheet = {
  pricingUrl: string;
  pricingReadDate: string;
  measured: {
    awakeMachineSeconds: number;
    asleepMachineSeconds: number;
    volumeGb: number;
    awakeMachineState: string | null;
    asleepMachineState: string | null;
    egressBytes: null;
    sourceRun: string;
    awakeAppName: string | null;
    asleepAppName: string | null;
  };
  rates: {
    machineUsdPerMonthAlwaysOn: number;
    machineUsdPerSec: number;
    volumeUsdPerGbMonth: number;
    stoppedRootfsUsdPerGbMonth: number;
    egressUsdPerGb: number;
  };
  assumptions: CostAssumptions & {
    notes: string[];
  };
  profiles: ProfileCost[];
};

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function profileCost(profile: UsageProfile, volumeGb: number, assumptions: CostAssumptions): ProfileCost {
  const awakeFraction = profile.awakeHoursPerDay / 24;
  const machineMonth = sharedCpu1xWithRamUsdPerMonth();
  const machineRunningUsd = round4(machineMonth * awakeFraction);
  const stoppedRootfsUsd = round4(
    (1 - awakeFraction) * assumptions.rootfsGb * FLY_STOPPED_ROOTFS_USD_PER_GB_MONTH,
  );
  const volumeUsd = round4(volumeGb * FLY_VOLUME_USD_PER_GB_MONTH);
  const egressUsd = round4(assumptions.egressGbPerMonth * FLY_EGRESS_NA_EU_USD_PER_GB);
  const totalUsd = round4(machineRunningUsd + stoppedRootfsUsd + volumeUsd + egressUsd);
  return {
    id: profile.id,
    label: profile.label,
    awakeHoursPerDay: profile.awakeHoursPerDay,
    awakeFraction: round6(awakeFraction),
    machineRunningUsd,
    stoppedRootfsUsd,
    volumeUsd,
    egressUsd,
    totalUsd,
    totalGbp: round4(totalUsd / assumptions.usdPerGbp),
  };
}

export function buildCostSheet(input: {
  awake: ProbeRecord;
  asleep: ProbeRecord;
  assumptions?: Partial<CostAssumptions>;
  sourceRun?: string;
}): CostSheet {
  const assumptions: CostAssumptions = { ...DEFAULT_ASSUMPTIONS, ...input.assumptions };
  const volumeGb = input.awake.volumeGb || input.asleep.volumeGb || 10;
  const machineMonth = sharedCpu1xWithRamUsdPerMonth();
  return {
    pricingUrl: FLY_PRICING_URL,
    pricingReadDate: FLY_PRICING_READ_DATE,
    measured: {
      awakeMachineSeconds: input.awake.machineSeconds,
      asleepMachineSeconds: input.asleep.machineSeconds,
      volumeGb,
      awakeMachineState: input.awake.machineState ?? null,
      asleepMachineState: input.asleep.machineState ?? null,
      egressBytes: null,
      sourceRun: input.sourceRun ?? "unknown",
      awakeAppName: input.awake.appName ?? null,
      asleepAppName: input.asleep.appName ?? null,
    },
    rates: {
      machineUsdPerMonthAlwaysOn: machineMonth,
      machineUsdPerSec: round6(sharedCpu1xWithRamUsdPerSec()),
      volumeUsdPerGbMonth: FLY_VOLUME_USD_PER_GB_MONTH,
      stoppedRootfsUsdPerGbMonth: FLY_STOPPED_ROOTFS_USD_PER_GB_MONTH,
      egressUsdPerGb: FLY_EGRESS_NA_EU_USD_PER_GB,
    },
    assumptions: {
      ...assumptions,
      notes: [
        "Egress GB/month is assumed (Machines list API returns null).",
        "Stopped rootfs GB is assumed (image size not measured on the probe).",
        "Machine USD/month uses Fly iad/ewr published shared-cpu-1x 1GB + 1GB additional RAM; staging region was lhr (regional uplift possible).",
        "Monthly profiles (24h / 8h / 1h) are usage assumptions; probe machine-seconds are short measured samples, not the profile durations.",
        "Asleep probe records machineState=suspended (Fly suspend; auto_destroy forbids stop) after Admin prepareSleep; billable machineSeconds while suspended are ~0.",
      ],
    },
    profiles: USAGE_PROFILES.map((p) => profileCost(p, volumeGb, assumptions)),
  };
}

export function formatCostSheetTable(sheet: CostSheet): string {
  const lines = [
    `Fly pricing: ${sheet.pricingUrl} (read ${sheet.pricingReadDate})`,
    `Source run: ${sheet.measured.sourceRun}`,
    `Measured awake machine-seconds: ${sheet.measured.awakeMachineSeconds}`,
    `Measured asleep machine-seconds: ${sheet.measured.asleepMachineSeconds}`,
    `Measured volume GB: ${sheet.measured.volumeGb}`,
    `Egress bytes measured: null (assumed ${sheet.assumptions.egressGbPerMonth} GB/month @ $${sheet.rates.egressUsdPerGb}/GB)`,
    `shared-cpu-1x 2GB always-on: $${sheet.rates.machineUsdPerMonthAlwaysOn}/month ($${sheet.rates.machineUsdPerSec}/sec)`,
    "",
    "profile\tawake_h/day\tmachine_usd\trootfs_stopped_usd\tvolume_usd\tegress_usd\ttotal_usd\ttotal_gbp",
  ];
  for (const p of sheet.profiles) {
    lines.push([
      p.id,
      p.awakeHoursPerDay,
      p.machineRunningUsd.toFixed(4),
      p.stoppedRootfsUsd.toFixed(4),
      p.volumeUsd.toFixed(4),
      p.egressUsd.toFixed(4),
      p.totalUsd.toFixed(4),
      p.totalGbp.toFixed(4),
    ].join("\t"));
  }
  return lines.join("\n");
}

/** Plan floor from S2.10: price_GBP = (cost_USD / 1.30 + 0.20) / (1 - 0.40 - 0.022). */
export function priceFloorGbp(costUsd: number): number {
  return round4((costUsd / 1.3 + 0.2) / (1 - 0.4 - 0.022));
}
