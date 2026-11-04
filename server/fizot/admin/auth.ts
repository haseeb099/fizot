/**
 * AuthProvider: identity only. Sign-in vendor is not chosen yet (P4.1).
 * Sessions are Fizot-issued cookies with server-side revocation.
 */
import type { IncomingMessage } from "node:http";
import type { AccountRecord, SessionContext, TenantStore } from "./tenant.ts";

export const SESSION_COOKIE_NAME = "fizot_admin_session";

export type AuthIdentity = { email: string; subject: string };

/** Vendor-agnostic identity bridge. Implement later for a real IdP. */
export interface AuthProvider {
  /** Resolve an email (or vendor subject) into a stable identity. */
  resolveIdentity(input: { email?: string; subject?: string }): Promise<AuthIdentity>;
}

/** Test / staging provider: email is the identity. No vendor. */
export class FakeAuthProvider implements AuthProvider {
  async resolveIdentity(input: { email?: string; subject?: string }): Promise<AuthIdentity> {
    const email = (input.email ?? input.subject ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw Object.assign(new Error("invalid_email"), { status: 400 });
    return { email, subject: `fake:${email}` };
  }
}

/** Placeholder until a vendor is bought — always refuses. */
export class UnconfiguredAuthProvider implements AuthProvider {
  async resolveIdentity(): Promise<AuthIdentity> {
    throw Object.assign(new Error("auth_provider_unconfigured"), { status: 501 });
  }
}

export type CookieOptions = {
  secure?: boolean;
  maxAgeSec?: number;
  path?: string;
};

export function formatSessionCookie(token: string, opts: CookieOptions = {}): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=${opts.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure !== false) parts.push("Secure");
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${opts.maxAgeSec}`);
  return parts.join("; ");
}

export function formatClearSessionCookie(opts: CookieOptions = {}): string {
  return formatSessionCookie("", { ...opts, maxAgeSec: 0 });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function readSessionToken(req: IncomingMessage): string | null {
  const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  const token = cookies[SESSION_COOKIE_NAME];
  return token && token.length >= 16 ? token : null;
}

export async function resolveRequestSession(
  tenant: TenantStore,
  req: IncomingMessage,
): Promise<SessionContext | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  return tenant.resolveSession(token);
}

/** Sign in: resolve identity → ensure account → mint session (rotating any prior cookie). */
export async function signInWithProvider(input: {
  tenant: TenantStore;
  auth: AuthProvider;
  email: string;
  priorToken?: string | null;
  ttlMs?: number;
}): Promise<{ account: AccountRecord; token: string; sessionId: string }> {
  const identity = await input.auth.resolveIdentity({ email: input.email });
  const account = await input.tenant.ensureAccount(identity.email);
  if (input.priorToken) {
    const rotated = await input.tenant.rotateSession(input.priorToken, { ttlMs: input.ttlMs });
    if (rotated && rotated.session.accountId === account.id) {
      return { account, token: rotated.token, sessionId: rotated.session.id };
    }
    await input.tenant.revokeSessionByToken(input.priorToken);
  }
  const minted = await input.tenant.createSession(account.id, { ttlMs: input.ttlMs });
  return { account, token: minted.token, sessionId: minted.session.id };
}
