export type ApiKeyScopes = string[];

export type ApiKeyRecord = {
  id: string;
  userId: string;
  apiId: string;
  keyHash: string;
  prefix: string;
  scopes: ApiKeyScopes;
  rateLimit: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  usageCount: number;
  revokedAt: Date | null;
};

const createId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export class ApiKeyRepository {
  private readonly records = new Map<string, ApiKeyRecord>();

  create(userId: string, apiId: string, keyHash: string, prefix: string, scopes: string[], rateLimit: number): ApiKeyRecord {
    const now = new Date();
    const record: ApiKeyRecord = {
      id: createId(),
      userId,
      apiId,
      keyHash,
      prefix,
      scopes: [...scopes],
      rateLimit,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      usageCount: 0,
      revokedAt: null
    };

    this.records.set(record.id, record);
    return { ...record, scopes: [...record.scopes] };
  }

  findByKeyPrefix(prefix: string): ApiKeyRecord[] {
    return this.toPublicRecords(
      [...this.records.values()].filter((record) => record.prefix === prefix && !record.revokedAt)
    );
  }

  findByUserAndApi(userId: string, apiId: string): ApiKeyRecord[] {
    return this.toPublicRecords(
      [...this.records.values()].filter(
        (record) => record.userId === userId && record.apiId === apiId && !record.revokedAt
      )
    );
  }

  revoke(id: string): ApiKeyRecord | null {
    const existing = this.records.get(id);
    if (!existing || existing.revokedAt) {
      return null;
    }

    const now = new Date();
    const updated: ApiKeyRecord = {
      ...existing,
      revokedAt: now,
      updatedAt: now
    };

    this.records.set(id, updated);
    return { ...updated, scopes: [...updated.scopes] };
  }

  recordUsage(id: string): ApiKeyRecord | null {
    const existing = this.records.get(id);
    if (!existing || existing.revokedAt) {
      return null;
    }

    const now = new Date();
    const updated: ApiKeyRecord = {
      ...existing,
      usageCount: existing.usageCount + 1,
      lastUsedAt: now,
      updatedAt: now
    };

    this.records.set(id, updated);
    return { ...updated, scopes: [...updated.scopes] };
  }

  private toPublicRecords(records: ApiKeyRecord[]): ApiKeyRecord[] {
    return records.map((record) => ({ ...record, scopes: [...record.scopes] }));
  }
}