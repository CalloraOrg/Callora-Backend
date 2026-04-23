import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';

export interface ApiKeyRecord {
  id: string;
  apiId: string;
  userId: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  rateLimitPerMinute: number | null;
  createdAt: Date;
}

const apiKeys: ApiKeyRecord[] = [];

function generatePlainKey(): string {
  return `ck_live_${randomBytes(24).toString('hex')}`;
}

function toHash(value: string): string {
  // Use bcrypt with salt for proper password hashing
  return bcrypt.hashSync(value, 10);
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
  }): { key: string; prefix: string } {
    if (!params) return { key: '', prefix: '' };
    
    const key = generatePlainKey();
    const prefix = key.slice(0, 16);

    apiKeys.push({
      id: randomBytes(8).toString('hex'),
      apiId: params.apiId,
      userId: params.userId,
      prefix,
      keyHash: toHash(key),
      scopes: params.scopes,
      rateLimitPerMinute: params.rateLimitPerMinute,
      createdAt: new Date()
    });

    return { key, prefix };
  },
  revoke(id: string, userId: string): 'success' | 'not_found' | 'forbidden' {
    const index = apiKeys.findIndex(k => k.id === id);
    if (index === -1) return 'not_found';
    if (apiKeys[index].userId !== userId) return 'forbidden';

    apiKeys.splice(index, 1);
    return 'success';
  },
  verify(key: string): ApiKeyRecord | null {
    if (!key || typeof key !== 'string') return null;
    
    // Find potential matches by prefix first for efficiency
    const prefix = key.slice(0, 16);
    const candidates = apiKeys.filter(k => constantTimeCompare(k.prefix, prefix));
    
    for (const candidate of candidates) {
      if (verifyHash(key, candidate.keyHash)) {
        // Return a copy without sensitive data
        return {
          id: candidate.id,
          apiId: candidate.apiId,
          userId: candidate.userId,
          prefix: candidate.prefix,
          keyHash: '[REDACTED]',
          scopes: candidate.scopes,
          rateLimitPerMinute: candidate.rateLimitPerMinute,
          createdAt: candidate.createdAt
        };
      }
    }
    
    return null;
  },
  rotate(id: string, userId: string): { success: true; newKey: string; prefix: string } | { success: false; error: 'not_found' | 'forbidden' } {
    const index = apiKeys.findIndex(k => k.id === id);
    if (index === -1) return { success: false, error: 'not_found' };
    if (apiKeys[index].userId !== userId) return { success: false, error: 'forbidden' };

    // Generate new key
    const newKey = generatePlainKey();
    const newPrefix = newKey.slice(0, 16);
    
    // Update existing record
    apiKeys[index].keyHash = toHash(newKey);
    apiKeys[index].prefix = newPrefix;
    
    return { success: true, newKey, prefix: newPrefix };
  },
  listForTesting(): ApiKeyRecord[] {
    return apiKeys.map(k => ({ ...k, scopes: [...k.scopes] }));
  },
  // Clear method for testing
  clear(): void {
    apiKeys.length = 0;
  }
};
