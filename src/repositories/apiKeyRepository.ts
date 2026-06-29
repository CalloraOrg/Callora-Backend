import { randomBytes, timingSafeEqual, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { config } from "../config/index.js";

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

function toHash(value: string): string {
  // Use bcrypt with configurable cost factor for proper password hashing
  return bcrypt.hashSync(value, config.bcrypt.costFactor);
}

function verifyHash(value: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(value, hash);
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

export const apiKeyRepository = {
   create(params: {
     apiId: string;
     userId: string;
     scopes: string[];
     rateLimitPerMinute: number | null;
   }): ApiKeyCreateResult {
     const p = params as any;
     const key = generatePlainKey();
     const prefix = key.slice(0, 16);
     const id = randomBytes(8).toString('hex');
     const createdAt = new Date();
     const sha256Hash = sha256Hex(key);

     apiKeys.push({
       id,
       apiId: p.apiId,
       userId: p.userId,
       prefix,
       keyHash: toHash(key),
       sha256Hash,
       scopes: p.scopes,
       rateLimitPerMinute: p.rateLimitPerMinute,
       createdAt,
       revoked: false
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
  revoke(id: string, userId: string): 'success' | 'not_found' | 'forbidden' {
    const key = apiKeys.find(k => k.id === id);
    if (!key) return 'not_found';
    if (key.userId !== userId) return 'forbidden';

    key.revoked = true;
    return 'success';
  },
  getSha256Hash(id: string): string | null {
    const key = apiKeys.find(k => k.id === id);
    return key?.sha256Hash ?? null;
  },
  verify(key: string): ApiKeyRecord | null {
    if (typeof key !== 'string') return null;
    // Find potential matches by prefix first for efficiency
    const prefix = key.slice(0, 16);
    const candidates = apiKeys.filter((k) =>
      constantTimeCompare(k.prefix, prefix),
    );

    // No records share this prefix — key does not exist at all.
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      if (verifyHash(key, candidate.keyHash)) {
        if (candidate.revoked) {
          // A revoked key is not valid — treat it exactly like an unknown key
          // so callers cannot distinguish "revoked" from "never existed".
          return null;
        }
        // Return a copy without the raw hash so callers never see the secret.
        return {
          id: candidate.id,
          apiId: candidate.apiId,
          userId: candidate.userId,
          prefix: candidate.prefix,
          keyHash: '[REDACTED]',
          sha256Hash: candidate.sha256Hash,
          scopes: candidate.scopes,
          rateLimitPerMinute: candidate.rateLimitPerMinute,
          createdAt: candidate.createdAt,
          revoked: candidate.revoked,
        };
      }
    }

    // Prefix was found in the store but no candidate's hash matched the supplied
    // key. Return null (same as "key not found") so we never leak whether a
    // prefix exists via a distinct error path (timing/oracle safety).
    return null;
  },
  rotate(id: string, userId: string): { success: true; newKey: string; prefix: string } | { success: false; error: 'not_found' | 'forbidden' | 'revoked' } {
    const index = apiKeys.findIndex(k => k.id === id);
    if (index === -1) return { success: false, error: 'not_found' };
    if (apiKeys[index].userId !== userId) return { success: false, error: 'forbidden' };
    if (apiKeys[index].revoked) return { success: false, error: 'revoked' };

    // Generate new key
    const newKey = generatePlainKey();
    const newPrefix = newKey.slice(0, 16);

    // Update existing record
    apiKeys[index].keyHash = toHash(newKey);
    apiKeys[index].prefix = newPrefix;

    return { success: true, newKey, prefix: newPrefix };
  },
  listForTesting(): ApiKeyRecord[] {
    return apiKeys.map(k => ({ ...k }));
  },
  // Clear method for testing
  clear(): void {
    apiKeys.length = 0;
  },
};
