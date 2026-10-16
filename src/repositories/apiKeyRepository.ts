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
  // Use the async bcrypt API so the event loop is not blocked during hashing.
  return bcrypt.hash(value, config.bcrypt.rounds);
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

/**
 * Short-lived LRU cache keyed by the sha256 of the raw API key. Only
 * successful verifications are cached. Entries are invalidated on revocation
 * and rotation so a revoked key never returns a cached hit.
 */
interface VerifyCacheEntry {
  record: ApiKeyRecord;
  expiresAt: number;
}

const VERIFY_CACHE_MAX_ENTRIES = 500;
const VERIFY_CACHE_TTL_MS = 5_000;

class LruVerifyCache {
  private readonly map = new Map<string, VerifyCacheEntry>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): ApiKeyRecord | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Refresh recency for LRU ordering.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.record;
  }

  set(key: string, record: ApiKeyRecord): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { record, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteByRecordId(id: string): void {
    for (const [cacheKey, entry] of this.map) {
      if (entry.record.id === id) {
        this.map.delete(cacheKey);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

const verifyCache = new LruVerifyCache(VERIFY_CACHE_MAX_ENTRIES, VERIFY_CACHE_TTL_MS);

import { getTokenRevocationService } from "../services/tokenRevocation.js";

function redactRecord(record: ApiKeyRecord): ApiKeyRecord {
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

export function createApiKeyRepository(backingRecords: ApiKeyRecord[] = apiKeys) {
  const localVerifyCache = new LruVerifyCache(VERIFY_CACHE_MAX_ENTRIES, VERIFY_CACHE_TTL_MS);

  return {
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

      backingRecords.push({
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
        revokedAt: null,
      });

      return { id, key, prefix, createdAt };
    },
    list(params: { userId: string; apiId?: string }): ApiKeyRecord[] {
      const { userId, apiId } = params;
      return backingRecords
        .filter(
          (record) =>
            record.userId === userId &&
            (apiId === undefined || record.apiId === apiId),
        )
        .map((record) => ({ ...record }));
    },
    listWithCursor(params: {
      userId: string;
      limit: number;
      cursor?: string;
    }): { keys: ApiKeyRecord[]; nextCursor: string | null; hasMore: boolean } {
      const { userId, limit, cursor } = params;

      let filteredKeys = backingRecords.filter((record) => record.userId === userId);

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
      const key = backingRecords.find((k) => k.id === id);
      if (!key) return 'not_found';
      if (key.userId !== userId) return 'forbidden';

      key.revoked = true;
      key.revokedAt = new Date();
      // Evict any cached verification for this key so a revoked key cannot
      // continue to authenticate from the cache.
      localVerifyCache.deleteByRecordId(id);
      verifyCache.deleteByRecordId(id);
      if (key.sha256Hash) {
        getTokenRevocationService().revoke(key.sha256Hash);
      }
      return 'success';
    },
    isRevokedByHash(sha256Hash: string): boolean {
      const record = backingRecords.find((k) =>
        constantTimeCompare(k.sha256Hash, sha256Hash),
      );
      return Boolean(record?.revoked);
    },
    getSha256Hash(id: string): string | null {
      const key = backingRecords.find((k) => k.id === id);
      return key?.sha256Hash ?? null;
    },
    async verify(key: string): Promise<ApiKeyRecord | null> {
      if (typeof key !== 'string') return null;

      const keySha256 = sha256Hex(key);

      // Fast path: a recently verified key is served from the LRU cache
      // without touching bcrypt. Revoked keys are evicted on revoke.
      const cached = localVerifyCache.get(keySha256);
      if (cached) {
        if (cached.revoked) {
          localVerifyCache.delete(keySha256);
          return null;
        }
        return redactRecord(cached);
      }

      // Find potential matches by prefix first for efficiency
      const prefix = key.slice(0, 16);
      const candidates = backingRecords.filter((k) =>
        constantTimeCompare(k.prefix, prefix),
      );

      // No records share this prefix — key does not exist at all.
      if (candidates.length === 0) return null;

      // High-entropy keys are exact-matched by their sha256 digest using a
      // constant-time comparison. This avoids the costly bcrypt path for the
      // common case while still falling back to bcrypt for legacy records.
      for (const candidate of candidates) {
        if (constantTimeCompare(candidate.sha256Hash, keySha256)) {
          if (candidate.revoked) {
            return null;
          }
          localVerifyCache.set(keySha256, candidate);
          return redactRecord(candidate);
        }
      }

      for (const candidate of candidates) {
        if (await verifyHash(key, candidate.keyHash)) {
          if (candidate.revoked) {
            return null;
          }
          if (!candidate.sha256Hash) {
            candidate.sha256Hash = keySha256;
          }
          localVerifyCache.set(keySha256, candidate);
          return redactRecord(candidate);
        }
      }

      return null;
    },
    async rotate(
      id: string,
      userId: string,
    ): Promise<
      | { success: true; newKey: string; prefix: string }
      | { success: false; error: 'not_found' | 'forbidden' | 'revoked' }
    > {
      const index = backingRecords.findIndex((k) => k.id === id);
      if (index === -1) return { success: false, error: 'not_found' };
      if (backingRecords[index].userId !== userId)
        return { success: false, error: 'forbidden' };
      if (backingRecords[index].revoked)
        return { success: false, error: 'revoked' };

      const newKey = generatePlainKey();
      const newPrefix = newKey.slice(0, 16);
      const newSha256Hash = sha256Hex(newKey);
      const newKeyHash = await toHash(newKey);

      backingRecords[index].keyHash = newKeyHash;
      backingRecords[index].prefix = newPrefix;
      backingRecords[index].sha256Hash = newSha256Hash;

      localVerifyCache.deleteByRecordId(id);
      verifyCache.deleteByRecordId(id);

      return { success: true, newKey, prefix: newPrefix };
    },
    listForTesting(): ApiKeyRecord[] {
      return backingRecords.map((k) => ({ ...k }));
    },
    clear(): void {
      backingRecords.length = 0;
      localVerifyCache.clear();
      verifyCache.clear();
    },
  };
}

export const apiKeyRepository = createApiKeyRepository(apiKeys);
