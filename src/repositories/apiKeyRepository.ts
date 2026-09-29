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
 * Short-lived cache of recently verified keys. Keyed by the sha256 digest of
 * the raw key so the secret is never held in the cache in plaintext. The
 * cache is bounded by both a max entry count (capacity) and a TTL so stale
 * entries are evicted even without pressure. Revocation evicts the entry
 * immediately.
 */
interface VerifiedKeyCacheEntry {
  keyId: string;
  expiresAt: number;
}

const VERIFIED_KEY_CACHE_CAPACITY = 500;
const VERIFIED_KEY_CACHE_TTL_MS = 60_000;

const verifiedKeyCache = new Map<string, VerifiedKeyCacheEntry>();

function cacheGet(keyDigest: string): string | null {
  const entry = verifiedKeyCache.get(keyDigest);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    verifiedKeyCache.delete(keyDigest);
    return null;
  }
  // Refresh recency for LRU ordering.
  verifiedKeyCache.delete(keyDigest);
  verifiedKeyCache.set(keyDigest, entry);
  return entry.keyId;
}

function cacheSet(keyDigest: string, keyId: string): void {
  if (verifiedKeyCache.has(keyDigest)) {
    verifiedKeyCache.delete(keyDigest);
  }
  verifiedKeyCache.set(keyDigest, {
    keyId,
    expiresAt: Date.now() + VERIFIED_KEY_CACHE_TTL_MS,
  });
  while (verifiedKeyCache.size > VERIFIED_KEY_CACHE_CAPACITY) {
    const oldest = verifiedKeyCache.keys().next().value;
    if (oldest === undefined) break;
    verifiedKeyCache.delete(oldest);
  }
}

function cacheEvictByKeyId(keyId: string): void {
  for (const [digest, entry] of verifiedKeyCache) {
    if (entry.keyId === keyId) {
      verifiedKeyCache.delete(digest);
    }
  }
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
  // Use the async bcrypt API so key creation never blocks the event loop.
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

function toPublicRecord(record: ApiKeyRecord): ApiKeyRecord {
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
    // Evict immediately so a revoked key can not be serviced from cache.
    cacheEvictByKeyId(id);
    return 'success';
  },
  getSha256Hash(id: string): string | null {
    const key = apiKeys.find(k => k.id === id);
    return key?.sha256Hash ?? null;
  },
  async verify(key: string): Promise<ApiKeyRecord | null> {
    if (typeof key !== 'string') return null;

    const keyDigest = sha256Hex(key);

    // Fast path: recently verified keys are served from the LRU cache.
    const cachedId = cacheGet(keyDigest);
    if (cachedId) {
      const cachedRecord = apiKeys.find((k) => k.id === cachedId);
      if (cachedRecord && !cachedRecord.revoked) {
        return toPublicRecord(cachedRecord);
      }
      // Stale or revoked cache entry — drop it and fall back to the slow
      // path so the caller gets the correct result.
      verifiedKeyCache.delete(keyDigest);
    }

    // Exact match on the high-entropy sha256 digest. This is a constant-time
    // comparison and avoids bcrypt for the common case without weakening
    // validation: the digest is derived from the full key and is not
    // guessable from the prefix.
    const digestMatch = apiKeys.find((k) =>
      constantTimeCompare(keyDigest, k.sha256Hash),
    );
    if (digestMatch) {
      if (digestMatch.revoked) {
        // A revoked key is not valid — treat it exactly like an unknown key
        // so callers cannot distinguish "revoked" from "never existed".
        return null;
      }
      cacheSet(keyDigest, digestMatch.id);
      return toPublicRecord(digestMatch);
    }

    // Fallback: find potential matches by prefix and compare the bcrypt hash
    // using the async API so the event loop is never blocked.
    const prefix = key.slice(0, 16);
    const candidates = apiKeys.filter((k) =>
      constantTimeCompare(k.prefix, prefix),
    );

    // No records share this prefix — key does not exist at all.
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      if (await verifyHash(key, candidate.keyHash)) {
        if (candidate.revoked) {
          // A revoked key is not valid — treat it exactly like an unknown key
          // so callers cannot distinguish "revoked" from "never existed".
          return null;
        }
        cacheSet(keyDigest, candidate.id);
        return toPublicRecord(candidate);
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
    const newKeyHash = await toHash(newKey);
    const newSha256Hash = sha256Hex(newKey);

    // Update existing record
    apiKeys[index].keyHash = newKeyHash;
    apiKeys[index].prefix = newPrefix;
    apiKeys[index].sha256Hash = newSha256Hash;
    // Invalidate any cache entries for the rotated key.
    cacheEvictByKeyId(id);

    return { success: true, newKey, prefix: newPrefix };
  },
  listForTesting(): ApiKeyRecord[] {
    return apiKeys.map(k => ({ ...k }));
  },
  // Clear method for testing
  clear(): void {
    apiKeys.length = 0;
    verifiedKeyCache.clear();
  },
};
