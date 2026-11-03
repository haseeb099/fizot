/** Used nonces refused for ADMIN_NONCE_TTL_MS (docs/cloud-pro.md: 10 minutes). */

export interface NonceStore {
  /** Returns false when the nonce is already reserved. `nowMs` drives expiry. */
  reserve(nonce: string, untilMs: number, nowMs?: number): Promise<boolean>;
  /** Drop expired entries. */
  prune(nowMs: number): Promise<void>;
}

export function createMemoryNonceStore(): NonceStore {
  const nonces = new Map<string, number>();
  return {
    async reserve(nonce, untilMs, nowMs = Date.now()) {
      for (const [seen, until] of nonces) if (until <= nowMs) nonces.delete(seen);
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, untilMs);
      return true;
    },
    async prune(nowMs) {
      for (const [seen, until] of nonces) if (until <= nowMs) nonces.delete(seen);
    },
  };
}
