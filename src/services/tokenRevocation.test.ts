import assert from 'node:assert/strict';
import {
  TokenRevocationService,
  getTokenRevocationService,
  resetTokenRevocationService,
} from './tokenRevocation.js';

describe('TokenRevocationService', () => {
  let service: TokenRevocationService;

  beforeEach(() => {
    service = new TokenRevocationService(1000, 500);
  });

  afterEach(() => {
    service.stopSweeper();
    service.clear();
  });

  describe('revoke and isRevoked', () => {
    it('marks a token as revoked', () => {
      const tokenHash = 'a'.repeat(64);

      assert.equal(service.isRevoked(tokenHash), false);

      service.revoke(tokenHash);

      assert.equal(service.isRevoked(tokenHash), true);
    });

    it('returns false after TTL expires', () => {
      const tokenHash = 'b'.repeat(64);

      service.revoke(tokenHash, Date.now() + 10);

      assert.equal(service.isRevoked(tokenHash), true);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          assert.equal(service.isRevoked(tokenHash), false);
          resolve();
        }, 50);
      });
    });

    it('survives sweeper running during TTL', () => {
      const tokenHash = 'c'.repeat(64);

      service.revoke(tokenHash, Date.now() + 200);

      assert.equal(service.isRevoked(tokenHash), true);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          assert.equal(service.isRevoked(tokenHash), true);
          resolve();
        }, 100);
      });
    });
  });

  describe('reinstate', () => {
    it('removes a revoked token from the list', () => {
      const tokenHash = 'd'.repeat(64);

      service.revoke(tokenHash);
      assert.equal(service.isRevoked(tokenHash), true);

      service.reinstate(tokenHash);
      assert.equal(service.isRevoked(tokenHash), false);
    });
  });

  describe('revokeAll', () => {
    it('revokes multiple tokens for a developer', () => {
      const tokenHashes = ['h'.repeat(64), 'i'.repeat(64), 'j'.repeat(64)];

      const count = service.revokeAll('dev_456', tokenHashes);

      assert.equal(count, 3);
      assert.equal(service.isRevoked('h'.repeat(64)), true);
      assert.equal(service.isRevoked('i'.repeat(64)), true);
      assert.equal(service.isRevoked('j'.repeat(64)), true);
    });
  });

  describe('getRevokedCount', () => {
    it('returns accurate count after cleanup', () => {
      service.revoke('expired_key_hash_1', Date.now() - 100);
      service.revoke('valid_key_hash_1', Date.now() + 1000);

      const count = service.getRevokedCount();

      assert.equal(count, 1);
    });
  });

  describe('singleton', () => {
    afterEach(() => {
      resetTokenRevocationService();
    });

    it('returns the same instance on repeated calls', () => {
      const service1 = getTokenRevocationService();
      const service2 = getTokenRevocationService();

      assert.strictEqual(service1, service2);
    });

    it('reset clears the singleton', () => {
      const service1 = getTokenRevocationService();

      resetTokenRevocationService();

      const service2 = getTokenRevocationService();

      assert.notStrictEqual(service1, service2);
    });
  });
});