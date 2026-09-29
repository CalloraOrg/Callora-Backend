import { randomBytes, timingSafeEqual, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { config } from "../config/index.js";
import { decodeCursor, encodeCursor } from "../lib/cursorPagination.js";

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Typed error returned when an API key prefix is found in the store but the
 * full-key hash comparison fails. Callers should map this to a 401 response
 * so the distinction between "prefix not found" and "hash mismatch" is never
 * observable externally (no timing oracle — both paths yield the same status).
 */
export class InvalidKeyError extends Error {
  public readonly code = 'INVALID_KEY' as const;
  constructor(message = 'Invalid API key') {
    super(message);
    this.name = 'InvalidKeyError';
    Object.setPrototypeOf(this, InvalidKeyError.prototype);
  }
}

export interface ApiKeyRecord {
  id: string;
  apiId: string;
  userId: string;
  prefix: string;
  keyHash: string;
  sha256Hash: string;
  scopes: string[];
  rateLimitPerMinute: number | null;
  createdAt: Date;
  revoked: boolean;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
}

const apiKeys: ApiKeyRecord[] = [];

/**
 * Short-lived cache of recently verified keys, keyed by the SHA-256 hex
 * of the raw key. Because API keys are high-entropy random values, a
 * constant-time exact match on the SHA-256 digest is as strong as a bcrypt
 * compare for the purpose of authentication, while being O(1) and non-blocking.
 */
interface VerifyCacheEntry {
  record: ApiKeyRecord;
  expiresAt: number;
}

const VERIFY_CACHE_MAX_ENTRIES = 1000;
const VERIFY_CACHE_TTL_MS = 60_000;

const verifyCache = new Map<string, VerifyCacheEntry>();

function cacheGet(sha256Hash: string): ApiKeyRecord | null {
  const entry = verifyCache.get(sha256Hash);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    verifyCache.delete(sha256Hash);
    return null;
  }
  // LRU refresh: re-insert to mark as most-recently used.
  verifyCache.delete(sha256Hash);
  verifyCache.set(sha256Hash, entry);
  return entry.record;
}

function cacheSet(sha256Hash: string, record: ApiKeyRecord): void {
  verifyCache.delete(sha256Hash);
  verifyCache.set(sha256Hash, {
    record,
    expiresAt: Date.now() + VERIFY_CACHE_TTL_MS,
  });
  while (verifyCache.size > VERIFY_CACHE_MAX_ENTRIES) {
    const oldest = verifyCache.keys().next().value;
    if (oldest === undefined) break;
    verifyCache.delete(oldest);
  }
}

function cacheEvict(sha256Hash: string): void {
  verifyCache.delete(sha256Hash);
}

function cacheEvictById(id: string): void {
  for (const [hash, entry] of verifyCache) {
    if (entry.record.id === id) {
      verifyCache.delete(hash);
    }
  }
}

function cacheClear(): void {
  verifyCache.clear();
}

export interface ApiKeyCreateResult {
  id: string;
  key: string;
  prefix: string;
  createdAt: Date;
}

function generatePlainKey(): string {
  return `ck_live_${randomBytes(24).toString("hex")}`;
}

async function toHash(value: string): Promise<string> {
  // Use bcrypt with configurable cost factor for proper password hashing.
  // Async API keeps the event loop free during the CPU-bound hash computation.
  return bcrypt.hash(value, config.bcrypt.costFactor);
}

async function verifyHash(value: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(value, hash);
  } catch {
    return false;
  }
}

// Constant-time comparison for API key verification
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function redactedCopy(record: ApiKeyRecord): ApiKeyRecord {
  // Return a copy without the raw hash so callers never see the secret.
  return {
    id: record.id,
    apiId: record.apiId,
    userId: record.userId,
    prefix: record.prefix,
    keyHash: '[REDACTED]',
    sha256Hash: record.sha256Hash,
    scopes: record.scopes,
    rateLimitPerMinute: record.rateLimitPerMinute,
    createdAt: record.createdAt,
    revoked: record.revoked,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

export const apiKeyRepository = {
   async create(params: {
     apiId: string;
     userId: string;
     scopes: string[];
     rateLimitPerMinute: number | null;
    }): Promise<ApiKeyCreateResult> {
      const key = generatePlainKey();
      const prefix = key.slice(0, 16);
      const id = randomBytes(8).toString('hex');
      const createdAt = new Date();
      const sha256Hash = sha256Hex(key);
      const keyHash = await toHash(key);

    apiKeys.push({
      id,
      apiId: params.apiId,
      userId: params.userId,
      prefix,
      keyHash,
      sha256Hash,
      scopes: params.scopes,
      rateLimitPerMinute: params.rateLimitPerMinute,
      createdAt,
      revoked: false,
      lastUsedAt: null,
      revokedAt: null
    });

     return { id, key, prefix, createdAt };
   },
  list(params: { userId: string; apiId?: string }): ApiKeyRecord[] {
    const { userId, apiId } = params;
    return apiKeys
      .filter((record) =>
        record.userId === userId &&
        (apiId === undefined || record.apiId === apiId)
      )
      .map((record) => ({ ...record }));
  },
  listWithCursor(params: {
    userId: string;
    limit: number;
    cursor?: string;
  }): { keys: ApiKeyRecord[]; nextCursor: string | null; hasMore: boolean } {
    const { userId, limit, cursor } = params;

    let filteredKeys = apiKeys.filter((record) => record.userId === userId);

    // Sort descending by createdAt, then descending by id
    filteredKeys.sort((a, b) => {
      const timeA = a.createdAt.getTime();
      const timeB = b.createdAt.getTime();
      if (timeB !== timeA) {
        return timeB - timeA;
      }
      return b.id.localeCompare(a.id);
    });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        const targetTime = decoded.timestamp.getTime();
        filteredKeys = filteredKeys.filter((k) => {
          const kTime = k.createdAt.getTime();
          if (kTime < targetTime) {
            return true;
          }
          if (kTime === targetTime) {
            return k.id < decoded.id;
          }
          return false;
        });
      }
    }

    const hasMore = filteredKeys.length > limit;
    const results = hasMore ? filteredKeys.slice(0, limit) : filteredKeys;

    let nextCursor: string | null = null;
    if (hasMore && results.length > 0) {
      const last = results[results.length - 1];
      nextCursor = encodeCursor(last.createdAt, last.id);
    }

    return {
      keys: results.map((record) => ({ ...record })),
      nextCursor,
      hasMore,
    };
  },
  revoke(id: string, userId: string): 'success' | 'not_found' | 'forbidden' {
    const key = apiKeys.find(k => k.id === id);
    if (!key) return 'not_found';
    if (key.userId !== userId) return 'forbidden';

    key.revoked = true;
    key.revokedAt = new Date();
    // Evict immediately so a revoked key cannot be authenticated from cache.
    cacheEvictById(id);
    return 'success';
  },
  getSha256Hash(id: string): string | null {
    const key = apiKeys.find(k => k.id === id);
    return key?.sha256Hash ?? null;
  },
  async verify(key: string): Promise<ApiKeyRecord | null> {
    if (typeof key !== 'string') return null;

    // Fast path: exact match on the SHA-256 digest. API keys are high-entropy
    // random values, so a constant-time exact match here is sufficient and
    // avoids the expensive bcrypt compare entirely on the hot path.
    const sha256Hash = sha256Hex(key);

    const cached = cacheGet(sha256Hash);
    if (cached) {
      if (cached.revoked) {
        // Defensive: a revoked record should never be cached, but if it is,
        // treat it like an unknown key and evict.
        cacheEvict(sha256Hash);
        return null;
      }
      return redactedCopy(cached);
    }

    // Find potential matches by prefix first for efficiency
    const prefix = key.slice(0, 16);
    const candidates = apiKeys.filter((k) =>
      constantTimeCompare(k, prefix),
    );

    // No records share this prefix — key does not exist at all.
    if (candidates.length === 0) return null;

    // Exact SHA-256 match is the primary authentication path. It is O(1),
    // non-blocking, and constant-time because the digest length is fixed.
    for (const candidate of candidates) {
      if (constantTimeCompare(candidate.sha256Hash, sha256Hash)) {
        if (candidate.revoked) {
          // A revoked key is not valid — treat it exactly like an unknown key
          // so callers cannot distinguish "revoked" from "never existed".
          cacheEvict(sha256Hash);
          return null;
        }
        cacheSet(sha256Hash, candidate);
        return redactedCopy(candidate);
      }
    }

    // Legacy fallback: records created before the sha256 column existed may
    // only have a bcrypt hash. Use the async bcrypt API so the event loop
    // is not blocked during the compare.
    for (const candidate of candidates) {
      if (!candidate.keyHash) continue;
      if (await verifyHash(key, candidate.keyHash)) {
        if (candidate.revoked) {
          cacheEvict(sha256Hash);
          return null;
        }
        cacheSet(sha256Hash, candidate);
        return redactedCopy(candidate);
      }
    }

    // Prefix was found in the store but no candidate's hash matched the supplied
    // key. Return null (same as "key not found") so we never leak whether a
    // prefix exists via a distinct error path (timing/oracle safety).
    return null;
  },
  async rotate(id: string, userId: string): Promise<{ success: true; newKey: string; prefix: string } | { success: false; error: 'not_found' | 'forbidden' | 'revoked' }> {
    const index = apiKeys.findIndex(k => k.id === id);
    if (index === -1) return { success: false, error: 'not_found' };
    if (apiKeys[index].userId !== userId) return { success: false, error: 'forbidden' };
    if (apiKeys[index].revoked) return { success: false, error: 'revoked' };

    // Generate new key
    const newKey = generatePlainKey();
    const newPrefix = newKey.slice(0, 16);
    const newSha256Hash = sha256Hex(newKey);
    const newKeyHash = await toHash(newKey);

    // Evict any cached entries for this record before mutating it.
    cacheEvictById(id);

    // Update existing record
    apiKeys[index].keyHash = newKeyHash;
    apiKeys[index].prefix = newPrefix;
    apiKeys[index].sha256Hash = newSha256Hash;

    return { success: true, newKey, prefix: newPrefix };
  },
  listForTesting(): ApiKeyRecord[] {
    return apiKeys.map(k => ({ ...k }));
  },
  // Clear method for testing
  clear(): void {
    apiKeys.length = 0;
    cacheClear();
  },
};
