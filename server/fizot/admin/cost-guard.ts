/**
 * Gate G0b spend cap: 100 GBP/month across Fly staging and model calls.
 * Refuse more than 2 live machines; always project daily cost before create.
 */

/** Fly published shared-cpu-1x rate (USD/sec), approx. Nov 2026. */
export const FLY_SHARED_CPU_1X_USD_PER_SEC = 0.000000692;
/** Fly published volume rate (USD/GB/month). */
export const FLY_VOLUME_USD_PER_GB_MONTH = 0.15;
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
  const volumeGb = input.volumeGb ?? 10;
  const usdPerGbp = input.usdPerGbp ?? 1.3;
  const machineUsdPerDay = FLY_SHARED_CPU_1X_USD_PER_SEC * 86_400;
  const volumeUsdPerDay = (FLY_VOLUME_USD_PER_GB_MONTH * volumeGb) / 30;
  const totalUsdPerDay = machineUsdPerDay + volumeUsdPerDay;
  return {
    machineUsdPerDay: round4(machineUsdPerDay),
    volumeUsdPerDay: round4(volumeUsdPerDay),
    totalUsdPerDay: round4(totalUsdPerDay),
    totalGbpPerDay: round4(totalUsdPerDay / usdPerGbp),
    monthlyUsdAtAlwaysOn: round4(totalUsdPerDay * 30),
    note: "shared-cpu-1x + 10 GB volume from Fly published pricing; egress not included",
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
