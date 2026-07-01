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

  it('uses default TTL when constructed without config', () => {
    const defaultService = new TokenRevocationService();
    defaultService.revoke('default_ttl_test_hash');
    assert.equal(defaultService.isRevoked('default_ttl_test_hash'), true);
    defaultService.stopSweeper();
    defaultService.clear();
  });

  it('uses custom TTL when provided via constructor', () => {
    const shortService = new TokenRevocationService(500);
    shortService.revoke('custom_ttl_test_hash', Date.now() + 100);
    assert.equal(shortService.isRevoked('custom_ttl_test_hash'), true);
    shortService.stopSweeper();
    shortService.clear();
  });

  it('falls back to default TTL when expiresAt is not provided', () => {
    const longLivedService = new TokenRevocationService(1000);
    longLivedService.revoke('no_expires_at_hash');
    assert.equal(longLivedService.isRevoked('no_expires_at_hash'), true);
    longLivedService.stopSweeper();
    longLivedService.clear();
  });

  it('falls back to default TTL when expiresAt is zero or negative', () => {
    const testService = new TokenRevocationService(1000);
    testService.revoke('zero_expires_at_hash', 0);
    testService.revoke('negative_expires_at_hash', -100);
    assert.equal(testService.isRevoked('zero_expires_at_hash'), true);
    assert.equal(testService.isRevoked('negative_expires_at_hash'), true);
    testService.stopSweeper();
    testService.clear();
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

  describe('sweeper', () => {
    it('removes expired entries via automatic sweeper', () => {
      const shortLivedService = new TokenRevocationService(100, 50);
      const tokenHash = 'sweep_test_hash_'.repeat(8).slice(0, 64);

      shortLivedService.revoke(tokenHash, Date.now() + 10);

      assert.equal(shortLivedService.isRevoked(tokenHash), true);
      assert.equal(shortLivedService.getRevokedCount(), 1);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          assert.equal(shortLivedService.isRevoked(tokenHash), false);
          assert.equal(shortLivedService.getRevokedCount(), 0);
          shortLivedService.stopSweeper();
          shortLivedService.clear();
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

    it('handles reinstate on non-existent token gracefully', () => {
      service.reinstate('non_existent_hash');
      assert.equal(service.isRevoked('non_existent_hash'), false);
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

    it('returns zero when no tokens revoked', () => {
      const count = service.getRevokedCount();
      assert.equal(count, 0);
    });
  });

  describe('clear', () => {
    it('removes all revoked tokens', () => {
      service.revoke('hash1');
      service.revoke('hash2');
      service.revoke('hash3');

      assert.equal(service.getRevokedCount(), 3);

      service.clear();

      assert.equal(service.getRevokedCount(), 0);
    });
  });

  describe('stopSweeper', () => {
    it('handles calling stopSweeper when no timer exists', () => {
      const noTimerService = new TokenRevocationService(1000, 500);
      noTimerService.stopSweeper();
      noTimerService.stopSweeper();
      noTimerService.clear();
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