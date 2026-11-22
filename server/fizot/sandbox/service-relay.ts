/**
 * Fail-closed relay for service-trust loopback writes (SECURITY.md Slack worker risk).
 * Session-less bot shells share loopback with the Slack worker; mutating SERVICE_ALLOW
 * routes require `OMB_SLACK_RELAY_TOKEN` so a prompt-injected shell cannot post Full-access work.
 */

import { timingSafeEqual } from "node:crypto";

import { serviceAllowed } from "../../request-auth.ts";

/** Mutating service routes that must not answer bare loopback without the relay token. */
export function serviceRelayWriteRequired(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(upper)) return false;
  if (path.startsWith("/api/internal/")) return false;
  if (path.startsWith("/api/testing/")) return false;
  return serviceAllowed(upper, path);
}

export function slackRelayTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.OMB_SLACK_RELAY_TOKEN?.trim() ?? "";
  return value.length >= 16 ? value : null;
}

function secureMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Null when the write may proceed; otherwise a 403 reason.
 * Missing/short token → fail closed (Slack worker must be configured before those routes work).
 */
export function serviceRelayDenial(input: {
  method: string;
  path: string;
  bearer: string | undefined;
  relayToken: string | null;
}): string | null {
  if (!serviceRelayWriteRequired(input.method, input.path)) return null;
  if (!input.relayToken) {
    return "forbidden: service relay token is not configured; mutating service routes are closed";
  }
  if (!secureMatch(input.bearer, input.relayToken)) {
    return "forbidden: service relay token required";
  }
  return null;
}
