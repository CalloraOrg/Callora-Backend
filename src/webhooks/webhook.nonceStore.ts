/**
 * In-memory nonce ledger for inbound webhook replay protection.
 *
 * Entries are scoped per developer so one subscriber cannot poison another's
 * nonce space. TTL matches the signature timestamp window: once a timestamp
 * would already be rejected as stale, the nonce can be forgotten.
 */

const SEPARATOR = '\u0000';

const used = new Map<string, number>();

function entryKey(scope: string, nonce: string): string {
  return `${scope}${SEPARATOR}${nonce}`;
}

export const WebhookNonceStore = {
  /**
   * Record a nonce as consumed. Returns false when the nonce is already
   * persisted and has not yet expired (replay).
   */
  consume(scope: string, nonce: string, ttlMs: number, now: number = Date.now()): boolean {
    this.purgeExpired(now);
    const key = entryKey(scope, nonce);
    const expiresAt = used.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    used.set(key, now + ttlMs);
    return true;
  },

  has(scope: string, nonce: string, now: number = Date.now()): boolean {
    const expiresAt = used.get(entryKey(scope, nonce));
    return expiresAt !== undefined && expiresAt > now;
  },

  /** Drop every nonce belonging to a developer (called on webhook deletion). */
  purgeScope(scope: string): void {
    const prefix = `${scope}${SEPARATOR}`;
    for (const key of used.keys()) {
      if (key.startsWith(prefix)) {
        used.delete(key);
      }
    }
  },

  purgeExpired(now: number = Date.now()): void {
    for (const [key, expiresAt] of used) {
      if (expiresAt <= now) {
        used.delete(key);
      }
    }
  },

  size(): number {
    return used.size;
  },

  /** Test helper. */
  clear(): void {
    used.clear();
  },
};
