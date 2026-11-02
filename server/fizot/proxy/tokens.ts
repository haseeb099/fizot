import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenRecord = {
  id: string;
  instanceId: string;
  hash: string;
  expiresAt: number;
  revokedAt: number | null;
};

export type MintInput = { instanceId: string; ttlSeconds: number };

const TOKEN_BODY = /^omb_ai_[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintPlainToken(): string {
  // 32 bytes → 43 base64url chars, matching trialCreditService's shape.
  return `omb_ai_${randomBytes(32).toString("base64url")}`;
}

export function isTrialShapedToken(token: string): boolean {
  return TOKEN_BODY.test(token);
}

export class TokenStore {
  private readonly byId = new Map<string, TokenRecord>();
  private readonly byHash = new Map<string, string>();

  mint(input: MintInput, now = Date.now()): { id: string; token: string; expiresAt: number } {
    const ttl = Math.min(Math.max(1, Math.floor(input.ttlSeconds)), 3600);
    if (!input.instanceId.trim()) throw new Error("instanceId required");
    const token = mintPlainToken();
    const id = randomBytes(12).toString("hex");
    const record: TokenRecord = {
      id,
      instanceId: input.instanceId,
      hash: hashToken(token),
      expiresAt: now + ttl * 1000,
      revokedAt: null,
    };
    this.byId.set(id, record);
    this.byHash.set(record.hash, id);
    return { id, token, expiresAt: record.expiresAt };
  }

  revoke(id: string, now = Date.now()): boolean {
    const record = this.byId.get(id);
    if (!record) return false;
    record.revokedAt = now;
    return true;
  }

  /** Effective within 60 s of revoke: any revokeAt in the past is already effective. */
  authorize(token: string, instanceId: string | undefined, now = Date.now()): TokenRecord | null {
    if (!isTrialShapedToken(token)) return null;
    const id = this.byHash.get(hashToken(token));
    if (!id) return null;
    const record = this.byId.get(id);
    if (!record) return null;
    if (record.revokedAt !== null && record.revokedAt <= now) return null;
    if (record.expiresAt <= now) return null;
    if (instanceId && record.instanceId !== instanceId) return null;
    return record;
  }

  /** Test helper: confirm hash compare is constant-time shaped. */
  hashesEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
