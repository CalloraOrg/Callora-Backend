import { ApiKeyRepository } from './apiKeyRepository.js';

describe('ApiKeyRepository', () => {
  it('creates a key and finds by prefix', () => {
    const repository = new ApiKeyRepository();

    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);
    const byPrefix = repository.findByKeyPrefix('prefix01');

    expect(created.id).toBeTruthy();
    expect(byPrefix).toHaveLength(1);
    expect(byPrefix[0]?.id).toBe(created.id);
  });

  it('finds keys by user and api', () => {
    const repository = new ApiKeyRepository();

    repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);
    repository.create('user-1', 'api-1', 'hash-2', 'prefix02', ['write'], 200);
    repository.create('user-1', 'api-2', 'hash-3', 'prefix03', ['read'], 100);

    const records = repository.findByUserAndApi('user-1', 'api-1');

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.apiId === 'api-1')).toBe(true);
  });

  it('revoke sets revokedAt and excludes key from lookups', () => {
    const repository = new ApiKeyRepository();
    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);

    const revoked = repository.revoke(created.id);

    expect(revoked).not.toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
    expect(repository.findByKeyPrefix('prefix01')).toHaveLength(0);
    expect(repository.findByUserAndApi('user-1', 'api-1')).toHaveLength(0);
  });

  it('recordUsage increments usage and updates lastUsedAt', () => {
    const repository = new ApiKeyRepository();
    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);

    const updated = repository.recordUsage(created.id);

    expect(updated).not.toBeNull();
    expect(updated?.usageCount).toBe(1);
    expect(updated?.lastUsedAt).not.toBeNull();
  });

  it('recordUsage returns null for revoked key', () => {
    const repository = new ApiKeyRepository();
    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);

    repository.revoke(created.id);

    expect(repository.recordUsage(created.id)).toBeNull();
  });
});