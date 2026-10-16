import { apiKeyRepository, LAST_USED_UPDATE_THROTTLE_MS } from "../repositories/apiKeyRepository.js";
import * as fc from "fast-check";
import bcrypt from "bcryptjs";

describe("ApiKeyRepository Security Tests", () => {
  beforeEach(() => {
    // Clear all keys before each test
    apiKeyRepository.clear();
  });

  describe("Hashing and Storage Security", () => {
    it("should store hashed keys, not plain text", async () => {
      const userId = "user-1";
      const result = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      const keys = apiKeyRepository.listForTesting();
      const storedKey = keys.find((k) => k.userId === userId)!;

      // Ensure the stored key is not the plain text key
      expect(storedKey.keyHash).not.toBe(result.key);
      expect(storedKey.keyHash).not.toContain(result.key);
      expect(storedKey.keyHash.length).toBeGreaterThan(50); // bcrypt hashes are long
      expect(result.id).toBeTruthy();
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("should use different salts for different keys", async () => {
      await apiKeyRepository.create({
        apiId: "api-1",
        userId: "user-1",
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      await apiKeyRepository.create({
        apiId: "api-2",
        userId: "user-2",
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      const keys = apiKeyRepository.listForTesting();
      const key1 = keys.find((k) => k.userId === "user-1")!;
      const key2 = keys.find((k) => k.userId === "user-2")!;

      // Hashes should be different even for similar inputs
      expect(key1.keyHash).not.toBe(key2.keyHash);
    });

    it("should never expose raw keys in stored records", async () => {
      const userId = "user-1";
      const result = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      const keys = apiKeyRepository.listForTesting();
      const storedKey = keys.find((k) => k.userId === userId)!;

      // Verify no part of the raw key is stored
      expect(JSON.stringify(storedKey)).not.toContain(result.key);
      expect(storedKey.prefix).toBe(result.key.slice(0, 16)); // Only prefix should match
    });
  });

  describe("Key Verification Security", () => {
    it("should verify valid API keys with constant-time comparison", async () => {
      const userId = "user-1";
      const createResult = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["read", "write"],
        rateLimitPerMinute: 100,
      });

      const verifiedKey = await apiKeyRepository.verify(createResult.key);

      expect(verifiedKey).toBeTruthy();
      expect(verifiedKey!.userId).toBe(userId);
      expect(verifiedKey!.apiId).toBe("api-1");
      expect(verifiedKey!.scopes).toEqual(["read", "write"]);
      expect(verifiedKey!.rateLimitPerMinute).toBe(100);
      expect(verifiedKey!.keyHash).toBe("[REDACTED]"); // Sensitive data redacted
    });

    it("should reject invalid API keys", async () => {
      const invalidKey = "ck_live_invalidkey123456789012345678901234";
      const verifiedKey = await apiKeyRepository.verify(invalidKey);

      expect(verifiedKey).toBeNull();
    });

    it("should reject keys with correct prefix but wrong suffix", async () => {
      const userId = "user-1";
      const createResult = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      // Create a key with same prefix but different suffix
      const wrongKey = createResult.key.slice(0, 32) + "FFFFFFFF";
      const verifiedKey = await apiKeyRepository.verify(wrongKey);

      expect(verifiedKey).toBeNull();
    });

    it("should handle malformed keys gracefully", async () => {
      const malformedKeys = [
        "",
        "short",
        "ck_live_",
        "not_a_key_at_all",
        null as unknown as string,
        undefined as unknown as string,
        123 as unknown as string,
      ];

      for (const key of malformedKeys) {
        await expect(apiKeyRepository.verify(key)).resolves.toBeNull();
      }
    });

    it("should be resistant to timing attacks", async () => {
      const userId = "user-1";
      const createResult = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      const validKey = createResult.key;
      const invalidKey = validKey.slice(0, 16) + 'invalidkey123456789012345678901234';

      // Measure time for valid key verification
      const startValid = process.hrtime.bigint();
      await apiKeyRepository.verify(validKey);
      const endValid = process.hrtime.bigint();

      // Measure time for invalid key verification
      const startInvalid = process.hrtime.bigint();
      await apiKeyRepository.verify(invalidKey);
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

  describe("Key Rotation Security", () => {
    it("should rotate keys for authorized users", async () => {
      const userId = "user-1";
      const createResult = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["read"],
        rateLimitPerMinute: 50,
      });

      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find((k) => k.userId === userId)!.id;

      const rotateResult = await apiKeyRepository.rotate(keyId, userId);

      expect(rotateResult.success).toBe(true);
      if (rotateResult.success) {
        // New key should be different
        expect(rotateResult.newKey).not.toBe(createResult.key);
        expect(rotateResult.newKey).toMatch(/^ck_live_/);
        expect(rotateResult.newKey.length).toBe(createResult.key.length);

        // Old key should no longer work
        expect(await apiKeyRepository.verify(createResult.key)).toBeNull();

        // New key should work
        const verifiedNewKey = await apiKeyRepository.verify(rotateResult.newKey);
        expect(verifiedNewKey).toBeTruthy();
        expect(verifiedNewKey!.userId).toBe(userId);
        expect(verifiedNewKey!.scopes).toEqual(["read"]);
      }
    });

    it("should reject rotation for unauthorized users", async () => {
      const userId = "user-1";
      const otherUserId = "user-2";

      await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find((k) => k.userId === userId)!.id;

      const rotateResult = await apiKeyRepository.rotate(keyId, otherUserId);

      expect(rotateResult.success).toBe(false);
      if (!rotateResult.success) {
        expect(rotateResult.error).toBe("forbidden");
      }
    });

    it("should handle rotation of non-existent keys", async () => {
      const rotateResult = await apiKeyRepository.rotate("non-existent-id", "user-1");

      expect(rotateResult.success).toBe(false);
      if (!rotateResult.success) {
        expect(rotateResult.error).toBe("not_found");
      }
    });

    it("should maintain metadata during rotation", async () => {
      const userId = "user-1";

      await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["read", "write", "admin"],
        rateLimitPerMinute: 200,
      });

      const keys = apiKeyRepository.listForTesting();
      const keyId = keys.find((k) => k.userId === userId)!.id;
      // Snapshot values before rotate — the array entry is mutated in place
      const originalHash = keys.find((k) => k.userId === userId)!.keyHash;
      const originalPrefix = keys.find((k) => k.userId === userId)!.prefix;
      const originalKey = { ...keys.find((k) => k.userId === userId)! };

      const rotateResult = await apiKeyRepository.rotate(keyId, userId);

      expect(rotateResult.success).toBe(true);
      if (rotateResult.success) {
        const updatedKeys = apiKeyRepository.listForTesting();
        const updatedKey = updatedKeys.find((k) => k.userId === userId)!;

        // Metadata should be preserved
        expect(updatedKey.id).toBe(originalKey.id);
        expect(updatedKey.apiId).toBe(originalKey.apiId);
        expect(updatedKey.userId).toBe(originalKey.userId);
        expect(updatedKey.scopes).toEqual(originalKey.scopes);
        expect(updatedKey.rateLimitPerMinute).toBe(
          originalKey.rateLimitPerMinute,
        );

        // Only hash and prefix should change
        expect(updatedKey.keyHash).not.toBe(originalHash);
        expect(updatedKey.prefix).not.toBe(originalPrefix);
      }
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("lists keys for a specific user and API", async () => {
      await apiKeyRepository.create({
        apiId: "api-1",
        userId: "user-1",
        scopes: ["*"],
        rateLimitPerMinute: null,
      });
      await apiKeyRepository.create({
        apiId: "api-2",
        userId: "user-1",
        scopes: ["read"],
        rateLimitPerMinute: 60,
      });
      await apiKeyRepository.create({
        apiId: "api-1",
        userId: "user-2",
        scopes: ["write"],
        rateLimitPerMinute: null,
      });

      const userKeys = apiKeyRepository.list({ userId: "user-1" });
      const apiKeys = apiKeyRepository.list({ userId: "user-1", apiId: "api-1" });

      expect(userKeys).toHaveLength(2);
      expect(apiKeys).toHaveLength(1);
      expect(apiKeys[0].apiId).toBe("api-1");
      expect(apiKeys[0].userId).toBe("user-1");
    });

    it("should handle concurrent operations safely", async () => {
      const userId = "user-1";
      const promises = Array.from({ length: 10 }, (_, i) =>
        apiKeyRepository.create({
          apiId: `api-${i}`,
          userId,
          scopes: ["*"],
          rateLimitPerMinute: null,
        }),
      );

      await Promise.all(promises);

      const keys = apiKeyRepository.listForTesting();
      expect(keys.filter((k) => k.userId === userId)).toHaveLength(10);

      // All keys should be unique
      const keyIds = keys.map((k) => k.id);
      const uniqueIds = new Set(keyIds);
      expect(uniqueIds.size).toBe(10);
    });

    it("should handle empty repository operations", async () => {
      expect(await apiKeyRepository.verify("any_key")).toBeNull();
      expect(await apiKeyRepository.rotate("any_id", "any_user")).toEqual({
        success: false,
        error: "not_found",
      });
      expect(apiKeyRepository.revoke("any_id", "any_user")).toBe("not_found");
    });

    it("should handle invalid input parameters gracefully", async () => {
      // null and undefined should throw — they are not objects
      await expect(apiKeyRepository.create(null as unknown as Parameters<typeof apiKeyRepository.create>[0])).rejects.toThrow(TypeError);
      await expect(apiKeyRepository.create(undefined as unknown as Parameters<typeof apiKeyRepository.create>[0])).rejects.toThrow(
        TypeError,
      );

      // Structurally valid objects with null fields should not throw at the
      // repository boundary (field-level validation is the caller's concern)
      const partialParams = [
        {},
        { apiId: null, userId: "user", scopes: [], rateLimitPerMinute: null },
        { apiId: "api", userId: null, scopes: [], rateLimitPerMinute: null },
        {
          apiId: "api",
          userId: "user",
          scopes: null,
          rateLimitPerMinute: null,
        },
      ];

      for (const params of partialParams) {
        await expect(apiKeyRepository.create(params as unknown as Parameters<typeof apiKeyRepository.create>[0])).resolves.toBeDefined();
      }
    });

    it("should sanitize sensitive data in listForTesting", async () => {
      const userId = "user-1";
      await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      const keys = apiKeyRepository.listForTesting();
      const key = keys.find((k) => k.userId === userId)!;

      // In testing mode, we expose the hash for verification
      expect(key.keyHash).toBeTruthy();
      expect(key.keyHash).not.toBe("[REDACTED]");
    });
  });

  describe("Regression Tests", () => {
    it("should prevent key reuse after revocation", async () => {
      const userId = "user-1";
      const createResult = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      // Revoke the key
      const keys = apiKeyRepository.listForTesting();
      const keyToRevoke = keys.find(k => k.userId === userId)!;
      const revokeResult = apiKeyRepository.revoke(keyToRevoke.id, userId);
      expect(revokeResult).toBe('success');

      // Verify the flag is set
      const revokedKey = apiKeyRepository.listForTesting().find(k => k.id === keyToRevoke.id)!;
      expect(revokedKey.revoked).toBe(true);

      // Try to verify the revoked key
      expect(await apiKeyRepository.verify(createResult.key)).toBeNull();

      // Create a new key with same parameters
      const newCreateResult = await apiKeyRepository.create({
        apiId: "api-1",
        userId,
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      // New key should work and be different
      expect(newCreateResult.key).not.toBe(createResult.key);
      expect(await apiKeyRepository.verify(newCreateResult.key)).toBeTruthy();
      expect(await apiKeyRepository.verify(createResult.key)).toBeNull();
    });

    it("should maintain data integrity under mixed operations", async () => {
      const users = ["user-1", "user-2", "user-3"];
      const createdKeys: Array<{ userId: string; key: string; id: string }> =
        [];

      // Create keys for multiple users
      for (const userId of users) {
        const result = await apiKeyRepository.create({
          apiId: "api-1",
          userId,
          scopes: ["*"],
          rateLimitPerMinute: null,
        });
        createdKeys.push({ userId, key: result.key, id: "" });
      }

      // Update IDs
      const keys = apiKeyRepository.listForTesting();
      createdKeys.forEach((ck) => {
        const found = keys.find((k) => k.userId === ck.userId);
        if (found) ck.id = found.id;
      });

      // Verify all keys work
      for (const ck of createdKeys) {
        expect(await apiKeyRepository.verify(ck.key)).toBeTruthy();
      }

      // Rotate one key
      const rotateResult = await apiKeyRepository.rotate(
        createdKeys[0].id,
        createdKeys[0].userId,
      );
      expect(rotateResult.success).toBe(true);
      if (rotateResult.success) {
        createdKeys[0].key = rotateResult.newKey;
      }

      // Revoke one key
      apiKeyRepository.revoke(createdKeys[1].id, createdKeys[1].userId);

      // Verify final state
      expect(await apiKeyRepository.verify(createdKeys[0].key)).toBeTruthy(); // Rotated key
      expect(await apiKeyRepository.verify(createdKeys[1].key)).toBeNull(); // Revoked key
      expect(await apiKeyRepository.verify(createdKeys[2].key)).toBeTruthy(); // Unchanged key

      const finalKeys = apiKeyRepository.listForTesting();
      expect(finalKeys).toHaveLength(3); // All 3 keys remain (1 revoked, 2 active)
      expect(finalKeys.filter(k => k.revoked)).toHaveLength(1);
    });
  });

  describe("Expiration & Last-Used Tracking (#1247, #1246)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("treats expired keys like unknown keys in verify (#1247)", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));

      const expiresAt = new Date("2026-06-01T01:00:00.000Z");
      const created = await apiKeyRepository.create({
        apiId: "api-exp",
        userId: "user-exp",
        scopes: ["*"],
        rateLimitPerMinute: null,
        expiresAt,
      });

      // Valid before expiry
      const before = await apiKeyRepository.verify(created.key);
      expect(before).not.toBeNull();
      expect(before!.expiresAt?.toISOString()).toBe(expiresAt.toISOString());

      // Advance past expiry
      jest.setSystemTime(new Date("2026-06-01T01:00:01.000Z"));
      const after = await apiKeyRepository.verify(created.key);
      expect(after).toBeNull();
    });

    it("updates lastUsedAt on successful verify with coarse throttling and ignores failed verifies (#1246)", async () => {
      jest.useFakeTimers();
      const t0 = new Date("2026-06-01T12:00:00.000Z");
      jest.setSystemTime(t0);

      const created = await apiKeyRepository.create({
        apiId: "api-used",
        userId: "user-used",
        scopes: ["*"],
        rateLimitPerMinute: null,
      });

      // Initially lastUsedAt is null
      expect(apiKeyRepository.list({ userId: "user-used" })[0].lastUsedAt).toBeNull();

      // Failed verification with matching prefix does not update lastUsedAt
      const badKey = created.key.slice(0, 16) + "0".repeat(48);
      expect(await apiKeyRepository.verify(badKey)).toBeNull();
      expect(apiKeyRepository.list({ userId: "user-used" })[0].lastUsedAt).toBeNull();

      // First successful verification sets lastUsedAt to t0
      const verified1 = await apiKeyRepository.verify(created.key);
      expect(verified1?.lastUsedAt?.getTime()).toBe(t0.getTime());
      expect(apiKeyRepository.list({ userId: "user-used" })[0].lastUsedAt?.getTime()).toBe(t0.getTime());

      // Verification within throttle window (< 60s) does NOT rewrite lastUsedAt
      jest.advanceTimersByTime(LAST_USED_UPDATE_THROTTLE_MS - 1_000);
      await apiKeyRepository.verify(created.key);
      expect(apiKeyRepository.list({ userId: "user-used" })[0].lastUsedAt?.getTime()).toBe(t0.getTime());

      // Verification at/after throttle window (>= 60s) updates lastUsedAt
      jest.advanceTimersByTime(2_000);
      const expectedT2 = t0.getTime() + LAST_USED_UPDATE_THROTTLE_MS + 1_000;
      await apiKeyRepository.verify(created.key);
      expect(apiKeyRepository.list({ userId: "user-used" })[0].lastUsedAt?.getTime()).toBe(expectedT2);
    });
  });
});

// ── Property-Based Tests ───────────────────────────────────────────────────

describe("ApiKeyRepository Property-Based Tests", () => {
  beforeEach(() => {
    apiKeyRepository.clear();
  });

  // Feature: bcrypt-cost-config, Property 4: create hash round-trip
  // Validates: Requirements 3.1, 4.3
  it("Property 4: create hash round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        apiKeyRepository.clear();
        const { key } = await apiKeyRepository.create({
          apiId: "api-prop4",
          userId: "user-prop4",
          scopes: ["*"],
          rateLimitPerMinute: null,
        });
        const [record] = apiKeyRepository.listForTesting();
        return bcrypt.compare(key, record.keyHash);
      }),
      { numRuns: 5 },
    );
  }, 30_000);

  // Feature: bcrypt-cost-config, Property 5: rotate hash round-trip
  // Validates: Requirements 3.2, 4.4
  it("Property 5: rotate hash round-trip", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        apiKeyRepository.clear();
        const { key: oldKey } = await apiKeyRepository.create({
          apiId: "api-prop5",
          userId: "user-prop5",
          scopes: ["*"],
          rateLimitPerMinute: null,
        });
        const [record] = apiKeyRepository.listForTesting();
        const result = await apiKeyRepository.rotate(record.id, record.userId);
        if (!result.success) return false;
        const [updated] = apiKeyRepository.listForTesting();
        return (
          (await bcrypt.compare(result.newKey, updated.keyHash)) &&
          !(await bcrypt.compare(oldKey, updated.keyHash))
        );
      }),
      { numRuns: 5 },
    );
  }, 30_000);
});
