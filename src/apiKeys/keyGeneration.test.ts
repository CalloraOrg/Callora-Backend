import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSecureKey, hashApiKey } from './keyGeneration.js';

test('keyGeneration generates a key, hash, and 8-char prefix', () => {
    const result = generateSecureKey();

    assert.ok(result.key);
    assert.ok(result.key.length >= 32);
    assert.equal(result.hash.length, 64);
    assert.equal(result.prefix.length, 8);
    assert.equal(result.prefix, result.key.slice(0, 8));
});

test('keyGeneration hashes deterministically with sha256', () => {
    const key = 'test-key-value';
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
});

test('keyGeneration generates unique keys in normal operation', () => {
    const first = generateSecureKey();
    const second = generateSecureKey();

    assert.notEqual(first.key, second.key);
    assert.notEqual(first.hash, second.hash);
});