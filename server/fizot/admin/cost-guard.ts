/**
 * Gate G0b spend cap: 100 GBP/month across Fly staging and model calls.
 * Refuse more than 2 live machines; always project daily cost before create.
 *
 * Machine rates: Fly pricing page via cost-sheet.ts (shared-cpu-1x 1 GB
 * $6.70/mo + $6.00/GB additional RAM → $12.70/mo for the 2 GB home).
 */
import {
  FIZOT_HOME_MEMORY_GB,
  FLY_PRICING_READ_DATE,
  FLY_PRICING_URL,
  FLY_VOLUME_USD_PER_GB_MONTH as COST_SHEET_VOLUME_USD_PER_GB_MONTH,
  sharedCpu1xWithRamUsdPerMonth,
  sharedCpu1xWithRamUsdPerSec,
} from "../cost-sheet.ts";

export const FLY_VOLUME_USD_PER_GB_MONTH = COST_SHEET_VOLUME_USD_PER_GB_MONTH;
/** Per-second rate for the Fizot home guest (shared-cpu-1x + 2 GB). */
export const FLY_SHARED_CPU_1X_USD_PER_SEC = sharedCpu1xWithRamUsdPerSec(FIZOT_HOME_MEMORY_GB);
export const MAX_STAGING_MACHINES = 2;
/** Hard stop: never leave a staging machine billed more than one hour for probes. */
export const MAX_PROBE_MACHINE_SECONDS = 3600;

export type CostProjection = {
  machineUsdPerDay: number;
  volumeUsdPerDay: number;
  totalUsdPerDay: number;
  totalGbpPerDay: number;
  monthlyUsdAtAlwaysOn: number;
  note: string;
};

export function projectDailyCost(input: {
  memoryMb?: number;
  volumeGb?: number;
  usdPerGbp?: number;
}): CostProjection {
  const memoryGb = (input.memoryMb ?? FIZOT_HOME_MEMORY_GB * 1024) / 1024;
  const volumeGb = input.volumeGb ?? 10;
  const usdPerGbp = input.usdPerGbp ?? 1.3;
  const machineUsdPerMonth = sharedCpu1xWithRamUsdPerMonth(memoryGb);
  const volumeUsdPerMonth = FLY_VOLUME_USD_PER_GB_MONTH * volumeGb;
  const machineUsdPerDay = machineUsdPerMonth / 30;
  const volumeUsdPerDay = volumeUsdPerMonth / 30;
  const totalUsdPerDay = machineUsdPerDay + volumeUsdPerDay;
  return {
    machineUsdPerDay: round4(machineUsdPerDay),
    volumeUsdPerDay: round4(volumeUsdPerDay),
    totalUsdPerDay: round4(totalUsdPerDay),
    totalGbpPerDay: round4(totalUsdPerDay / usdPerGbp),
    monthlyUsdAtAlwaysOn: round4(machineUsdPerMonth + volumeUsdPerMonth),
    note: `shared-cpu-1x ${memoryGb} GB ($${machineUsdPerMonth}/mo) + ${volumeGb} GB volume from ${FLY_PRICING_URL} (read ${FLY_PRICING_READ_DATE}); egress not included`,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function formatCostProjection(p: CostProjection): string {
  return [
    `projected daily cost: $${p.totalUsdPerDay} (~£${p.totalGbpPerDay})`,
    `  machine shared-cpu-1x: $${p.machineUsdPerDay}/day`,
    `  volume: $${p.volumeUsdPerDay}/day`,
    `  always-on month ≈ $${p.monthlyUsdAtAlwaysOn}`,
    `  ${p.note}`,
  ].join("\n");
}

export class CostGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostGuardError";
  }
}

/** Call before creating a machine. Throws when the staging org is already at the cap. */
export function assertMachineBudget(liveMachineCount: number, max = MAX_STAGING_MACHINES): CostProjection {
  const projection = projectDailyCost({});
  if (liveMachineCount >= max) {
    throw new CostGuardError(
      `cost guard: refusing create — ${liveMachineCount} live machines already (max ${max}). Cap is 100 GBP/month (Gate G0b).`,
    );
  }
  return projection;
}
