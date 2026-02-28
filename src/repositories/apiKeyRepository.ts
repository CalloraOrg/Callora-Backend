import { createHash, randomBytes } from 'crypto';

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
  return createHash('sha256').update(value).digest('hex');
}

export const apiKeyRepository = {
  create(params: {
    apiId: string;
    userId: string;
    scopes: string[];
    rateLimitPerMinute: number | null;
  }): { key: string; prefix: string } {
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
  listForTesting(): ApiKeyRecord[] {
    return [...apiKeys];
  }
};
