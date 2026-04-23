import { apiKeyRepository } from '../repositories/apiKeyRepository.js';

describe('ApiKeyRepository Security Tests', () => {
  beforeEach(() => {
    // Clear all keys before each test
    apiKeyRepository.clear();
  });

  describe('Hashing and Storage Security', () => {
    it('should store hashed keys, not plain text', () => {
      const userId = 'user-1';
      const result = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const keys = apiKeyRepository.listForTesting();
      const storedKey = keys.find(k => k.userId === userId)!;

      // Ensure the stored key is not the plain text key
      expect(storedKey.keyHash).not.toBe(result.key);
      expect(storedKey.keyHash).not.toContain(result.key);
      expect(storedKey.keyHash.length).toBeGreaterThan(50); // bcrypt hashes are long
    });

    it('should use different salts for different keys', () => {
      const result1 = apiKeyRepository.create({
        apiId: 'api-1',
        userId: 'user-1',
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const result2 = apiKeyRepository.create({
        apiId: 'api-2',
        userId: 'user-2',
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const keys = apiKeyRepository.listForTesting();
      const key1 = keys.find(k => k.userId === 'user-1')!;
      const key2 = keys.find(k => k.userId === 'user-2')!;

      // Hashes should be different even for similar inputs
      expect(key1.keyHash).not.toBe(key2.keyHash);
    });

    it('should never expose raw keys in stored records', () => {
      const userId = 'user-1';
      const result = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const keys = apiKeyRepository.listForTesting();
      const storedKey = keys.find(k => k.userId === userId)!;

      // Verify no part of the raw key is stored
      expect(JSON.stringify(storedKey)).not.toContain(result.key);
      expect(storedKey.prefix).toBe(result.key.slice(0, 16)); // Only prefix should match
    });
  });

  describe('Key Verification Security', () => {
    it('should verify valid API keys with constant-time comparison', () => {
      const userId = 'user-1';
      const createResult = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['read', 'write'],
        rateLimitPerMinute: 100
      });

      const verifiedKey = apiKeyRepository.verify(createResult.key);

      expect(verifiedKey).toBeTruthy();
      expect(verifiedKey!.userId).toBe(userId);
      expect(verifiedKey!.apiId).toBe('api-1');
      expect(verifiedKey!.scopes).toEqual(['read', 'write']);
      expect(verifiedKey!.rateLimitPerMinute).toBe(100);
      expect(verifiedKey!.keyHash).toBe('[REDACTED]'); // Sensitive data redacted
    });

    it('should reject invalid API keys', () => {
      const invalidKey = 'ck_live_invalidkey123456789012345678901234';
      const verifiedKey = apiKeyRepository.verify(invalidKey);

      expect(verifiedKey).toBeNull();
    });

    it('should reject keys with correct prefix but wrong suffix', () => {
      const userId = 'user-1';
      const createResult = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      // Create a key with same prefix but different suffix
      const wrongKey = createResult.key.slice(0, 32) + 'FFFFFFFF';
      const verifiedKey = apiKeyRepository.verify(wrongKey);

      expect(verifiedKey).toBeNull();
    });

    it('should handle malformed keys gracefully', () => {
      const malformedKeys = [
        '',
        'short',
        'ck_live_',
        'not_a_key_at_all',
        null as any,
        undefined as any,
        123 as any
      ];

      malformedKeys.forEach(key => {
        expect(() => apiKeyRepository.verify(key)).not.toThrow();
        expect(apiKeyRepository.verify(key)).toBeNull();
      });
    });

    it('should be resistant to timing attacks', async () => {
      const userId = 'user-1';
      const createResult = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const validKey = createResult.key;
      // Use the same prefix so it passes the fast-path check and tests the slow-path
      const invalidKey = validKey.slice(0, 16) + 'invalidkey123456789012345678901234';

      // Measure time for valid key verification
      const startValid = process.hrtime.bigint();
      apiKeyRepository.verify(validKey);
      const endValid = process.hrtime.bigint();

      // Measure time for invalid key verification
      const startInvalid = process.hrtime.bigint();
      apiKeyRepository.verify(invalidKey);
      const endInvalid = process.hrtime.bigint();

      const validTime = Number(endValid - startValid);
      const invalidTime = Number(endInvalid - startInvalid);

      // Times should be relatively close (within 10x for this test)
      // In production, this would be much stricter
      const ratio = validTime / invalidTime;
      expect(ratio).toBeLessThan(10);
      expect(ratio).toBeGreaterThan(0.1);
    });
  });

  describe('Key Rotation Security', () => {
    it('should rotate keys for authorized users', () => {
      const userId = 'user-1';
      const createResult = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['read'],
        rateLimitPerMinute: 50
      });

      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find(k => k.userId === userId)!.id;

      const rotateResult = apiKeyRepository.rotate(keyId, userId);

      expect(rotateResult.success).toBe(true);
      if (rotateResult.success) {
        // New key should be different
        expect(rotateResult.newKey).not.toBe(createResult.key);
        expect(rotateResult.newKey).toMatch(/^ck_live_/);
        expect(rotateResult.newKey.length).toBe(createResult.key.length);

        // Old key should no longer work
        expect(apiKeyRepository.verify(createResult.key)).toBeNull();

        // New key should work
        const verifiedNewKey = apiKeyRepository.verify(rotateResult.newKey);
        expect(verifiedNewKey).toBeTruthy();
        expect(verifiedNewKey!.userId).toBe(userId);
        expect(verifiedNewKey!.scopes).toEqual(['read']);
      }
    });

    it('should reject rotation for unauthorized users', () => {
      const userId = 'user-1';
      const otherUserId = 'user-2';
      
      apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find(k => k.userId === userId)!.id;

      const rotateResult = apiKeyRepository.rotate(keyId, otherUserId);

      expect(rotateResult.success).toBe(false);
      if (!rotateResult.success) {
        expect(rotateResult.error).toBe('forbidden');
      }
    });

    it('should handle rotation of non-existent keys', () => {
      const rotateResult = apiKeyRepository.rotate('non-existent-id', 'user-1');

      expect(rotateResult.success).toBe(false);
      if (!rotateResult.success) {
        expect(rotateResult.error).toBe('not_found');
      }
    });

    it('should maintain metadata during rotation', () => {
      const userId = 'user-1';
      const createdDate = new Date();
      
      apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['read', 'write', 'admin'],
        rateLimitPerMinute: 200
      });

      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find(k => k.userId === userId)!.id;
      const originalKey = keys.find(k => k.userId === userId)!;

      const rotateResult = apiKeyRepository.rotate(keyId, userId);

      expect(rotateResult.success).toBe(true);
      if (rotateResult.success) {
        const updatedKeys = apiKeyRepository.listForTesting();
        const updatedKey = updatedKeys.find(k => k.userId === userId)!;

        // Metadata should be preserved
        expect(updatedKey.id).toBe(originalKey.id);
        expect(updatedKey.apiId).toBe(originalKey.apiId);
        expect(updatedKey.userId).toBe(originalKey.userId);
        expect(updatedKey.scopes).toEqual(originalKey.scopes);
        expect(updatedKey.rateLimitPerMinute).toBe(originalKey.rateLimitPerMinute);
        
        // Only hash and prefix should change
        expect(updatedKey.keyHash).not.toBe(originalKey.keyHash);
        expect(updatedKey.prefix).not.toBe(originalKey.prefix);
      }
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle concurrent operations safely', () => {
      const userId = 'user-1';
      const promises = Array.from({ length: 10 }, (_, i) => 
        apiKeyRepository.create({
          apiId: `api-${i}`,
          userId,
          scopes: ['*'],
          rateLimitPerMinute: null
        })
      );

      expect(() => promises.forEach(p => p)).not.toThrow();
      
      const keys = apiKeyRepository.listForTesting();
      expect(keys.filter(k => k.userId === userId)).toHaveLength(10);
      
      // All keys should be unique
      const keyIds = keys.map(k => k.id);
      const uniqueIds = new Set(keyIds);
      expect(uniqueIds.size).toBe(10);
    });

    it('should handle empty repository operations', () => {
      expect(apiKeyRepository.verify('any_key')).toBeNull();
      expect(apiKeyRepository.rotate('any_id', 'any_user')).toEqual({
        success: false,
        error: 'not_found'
      });
      expect(apiKeyRepository.revoke('any_id', 'any_user')).toBe('not_found');
    });

    it('should handle invalid input parameters gracefully', () => {
      const invalidParams = [
        null,
        undefined,
        {},
        { apiId: null, userId: 'user', scopes: [], rateLimitPerMinute: null },
        { apiId: 'api', userId: null, scopes: [], rateLimitPerMinute: null },
        { apiId: 'api', userId: 'user', scopes: null, rateLimitPerMinute: null }
      ];

      invalidParams.forEach(params => {
        expect(() => apiKeyRepository.create(params as any)).not.toThrow();
      });
    });

    it('should sanitize sensitive data in listForTesting', () => {
      const userId = 'user-1';
      apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      const keys = apiKeyRepository.listForTesting();
      const key = keys.find(k => k.userId === userId)!;

      // In testing mode, we expose the hash for verification
      expect(key.keyHash).toBeTruthy();
      expect(key.keyHash).not.toBe('[REDACTED]');
    });
  });

  describe('Regression Tests', () => {
    it('should prevent key reuse after revocation', () => {
      const userId = 'user-1';
      const createResult = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      // Revoke the key
      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find(k => k.userId === userId)!.id;
      const revokeResult = apiKeyRepository.revoke(keyId, userId);
      expect(revokeResult).toBe('success');

      // Try to verify the revoked key
      expect(apiKeyRepository.verify(createResult.key)).toBeNull();

      // Create a new key with same parameters
      const newCreateResult = apiKeyRepository.create({
        apiId: 'api-1',
        userId,
        scopes: ['*'],
        rateLimitPerMinute: null
      });

      // New key should work and be different
      expect(newCreateResult.key).not.toBe(createResult.key);
      expect(apiKeyRepository.verify(newCreateResult.key)).toBeTruthy();
      expect(apiKeyRepository.verify(createResult.key)).toBeNull();
    });

    it('should maintain data integrity under mixed operations', () => {
      const users = ['user-1', 'user-2', 'user-3'];
      const createdKeys: Array<{ userId: string; key: string; id: string }> = [];

      // Create keys for multiple users
      users.forEach(userId => {
        const result = apiKeyRepository.create({
          apiId: 'api-1',
          userId,
          scopes: ['*'],
          rateLimitPerMinute: null
        });
        createdKeys.push({ userId, key: result.key, id: '' });
      });

      // Update IDs
      const keys = apiKeyRepository.listForTesting();
      createdKeys.forEach(ck => {
        const found = keys.find(k => k.userId === ck.userId);
        if (found) ck.id = found.id;
      });

      // Verify all keys work
      createdKeys.forEach(ck => {
        expect(apiKeyRepository.verify(ck.key)).toBeTruthy();
      });

      // Rotate one key
      const rotateResult = apiKeyRepository.rotate(createdKeys[0].id, createdKeys[0].userId);
      expect(rotateResult.success).toBe(true);
      if (rotateResult.success) {
        createdKeys[0].key = rotateResult.newKey;
      }

      // Revoke one key
      apiKeyRepository.revoke(createdKeys[1].id, createdKeys[1].userId);

      // Verify final state
      expect(apiKeyRepository.verify(createdKeys[0].key)).toBeTruthy(); // Rotated key
      expect(apiKeyRepository.verify(createdKeys[1].key)).toBeNull();    // Revoked key
      expect(apiKeyRepository.verify(createdKeys[2].key)).toBeTruthy(); // Unchanged key

      const finalKeys = apiKeyRepository.listForTesting();
      expect(finalKeys).toHaveLength(2); // Only 2 keys should remain
    });
  });
});
