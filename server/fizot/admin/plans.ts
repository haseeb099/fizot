/** Plan and feature-flag rules for provisioning. */

export type PlanId = "home" | "team";

export type PlanFlags = {
  role: "home" | "team";
  volumeGb: number;
  memoryMb: number;
  cpus: number;
  sleepAllowed: boolean;
  /** Max memberships on the workspace (Team = up to 5 people, P4.4 plan). */
  seatMax: number;
};

const PLANS: Record<PlanId, PlanFlags> = {
  home: { role: "home", volumeGb: 10, memoryMb: 2048, cpus: 1, sleepAllowed: true, seatMax: 1 },
  team: { role: "team", volumeGb: 10, memoryMb: 2048, cpus: 1, sleepAllowed: false, seatMax: 5 },
};

export function planFlags(plan: string): PlanFlags | null {
  if (plan !== "home" && plan !== "team") return null;
  return { ...PLANS[plan] };
}

export function assertPlanAllows(plan: PlanId, flag: keyof PlanFlags, value: unknown): boolean {
  const flags = PLANS[plan];
  return flags[flag] === value;
}

export function seatMaxForPlan(plan: PlanId): number {
  return PLANS[plan].seatMax;
}
