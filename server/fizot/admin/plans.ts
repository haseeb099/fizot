/** Plan and feature-flag rules for provisioning (skeleton). */

export type PlanId = "home" | "team";

export type PlanFlags = {
  role: "home" | "team";
  volumeGb: number;
  memoryMb: number;
  cpus: number;
  sleepAllowed: boolean;
};

const PLANS: Record<PlanId, PlanFlags> = {
  home: { role: "home", volumeGb: 10, memoryMb: 2048, cpus: 1, sleepAllowed: true },
  team: { role: "team", volumeGb: 10, memoryMb: 2048, cpus: 1, sleepAllowed: false },
};

export function planFlags(plan: string): PlanFlags | null {
  if (plan !== "home" && plan !== "team") return null;
  return { ...PLANS[plan] };
}

export function assertPlanAllows(plan: PlanId, flag: keyof PlanFlags, value: unknown): boolean {
  const flags = PLANS[plan];
  return flags[flag] === value;
}
