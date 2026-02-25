import { generateSecureKey, hashApiKey } from './keyGeneration.js';

describe('keyGeneration', () => {
  it('should generate a key, hash, and 8-char prefix', () => {
    const result = generateSecureKey();

    expect(result.key).toBeTruthy();
    expect(result.key.length).toBeGreaterThanOrEqual(32);
    expect(result.hash).toHaveLength(64);
    expect(result.prefix).toHaveLength(8);
    expect(result.prefix).toBe(result.key.slice(0, 8));
  });

  it('should hash deterministically with sha256', () => {
    const key = 'test-key-value';
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('should generate unique keys in normal operation', () => {
    const first = generateSecureKey();
    const second = generateSecureKey();

    expect(first.key).not.toBe(second.key);
    expect(first.hash).not.toBe(second.hash);
  });
});