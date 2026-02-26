import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiKeyRepository } from './apiKeyRepository.js';

test('ApiKeyRepository creates a key and finds by prefix', () => {
    const repository = new ApiKeyRepository();

    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);
    const byPrefix = repository.findByKeyPrefix('prefix01');

    assert.ok(created.id);
    assert.equal(byPrefix.length, 1);
    assert.equal(byPrefix[0]?.id, created.id);
});

test('ApiKeyRepository finds keys by user and api', () => {
    const repository = new ApiKeyRepository();

    repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);
    repository.create('user-1', 'api-1', 'hash-2', 'prefix02', ['write'], 200);
    repository.create('user-1', 'api-2', 'hash-3', 'prefix03', ['read'], 100);

    const records = repository.findByUserAndApi('user-1', 'api-1');

    assert.equal(records.length, 2);
    assert.equal(records.every((record) => record.apiId === 'api-1'), true);
});

test('ApiKeyRepository revoke sets revokedAt and excludes key from lookups', () => {
    const repository = new ApiKeyRepository();
    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);

    const revoked = repository.revoke(created.id);

    assert.notEqual(revoked, null);
    assert.notEqual(revoked?.revokedAt, null);
    assert.equal(repository.findByKeyPrefix('prefix01').length, 0);
    assert.equal(repository.findByUserAndApi('user-1', 'api-1').length, 0);
});

test('ApiKeyRepository recordUsage increments usage and updates lastUsedAt', () => {
    const repository = new ApiKeyRepository();
    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);

    const updated = repository.recordUsage(created.id);

    assert.notEqual(updated, null);
    assert.equal(updated?.usageCount, 1);
    assert.notEqual(updated?.lastUsedAt, null);
});

test('ApiKeyRepository recordUsage returns null for revoked key', () => {
    const repository = new ApiKeyRepository();
    const created = repository.create('user-1', 'api-1', 'hash-1', 'prefix01', ['read'], 100);

    repository.revoke(created.id);

    assert.equal(repository.recordUsage(created.id), null);
});