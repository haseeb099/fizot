/** Fizot has no enterprise adapter, so a hosted-admin variable must stop boot. */
export const FIZOT_FORBIDDEN_ADMIN_ENV = ["OMB_ADMIN_URL", "OMB_ADMIN_WORKSPACE", "OMB_ADMIN_MEMBERSHIP"] as const;

export function forbiddenAdminEnv(env: NodeJS.ProcessEnv): string[] {
  return FIZOT_FORBIDDEN_ADMIN_ENV.filter((name) => env[name] !== undefined);
}

export function rejectFizotAdminEnv(env: NodeJS.ProcessEnv = process.env): void {
  const set = forbiddenAdminEnv(env);
  if (set.length === 0) return;
  const message = `Fizot refuses to boot while ${set.join(", ")} is set`;
  console.error(message);
  throw new Error(message);
}
