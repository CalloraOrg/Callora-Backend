import request from 'supertest';
import express from 'express';
import { apiKeyRepository } from '../repositories/apiKeyRepository.js';
import { errorHandler } from '../middleware/errorHandler.js';

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Mock requireAuth to accept essentially any user
  app.use((req, res, next) => {
    const userId = req.headers['x-user-id'] as string;
    if (userId) {
      res.locals.authenticatedUser = {
        id: userId,
        email: `${userId}@example.com`,
      };
      next();
    } else {
      res.status(401).json({ error: 'Authentication required' });
    }
  });

  app.delete('/api/keys/:id', (req, res: express.Response<unknown, { authenticatedUser: { id: string, email: string } }>) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const result = apiKeyRepository.revoke(id, user.id);

    if (result === 'forbidden') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    res.status(204).send();
  });

  app.use(errorHandler);
  return app;
}

describe('API Key Revocation Route', () => {
  beforeEach(() => {
    // Clear the keys before each test
    apiKeyRepository.clear();
  });

  it('revokes an API key successfully', async () => {
    const app = createTestApp();

    // Create a key in the repository
    const userId = 'user-1';
    apiKeyRepository.create({
      apiId: 'api-1',
      userId: userId,
      scopes: ['*'],
      rateLimitPerMinute: null
    });

    const keys = apiKeyRepository.listForTesting();
    const keyToRevoke = keys.find(k => k.userId === userId)!;
    expect(keyToRevoke).toBeDefined();

    const response = await request(app)
      .delete(`/api/keys/${keyToRevoke.id}`)
      .set('x-user-id', userId);

    expect(response.status).toBe(204);

    // Verify it is gone
    const updatedKeys = apiKeyRepository.listForTesting();
    expect(updatedKeys.find(k => k.id === keyToRevoke.id)).toBeUndefined();
  });

  it('returns 204 successfully when revoking an already revoked/non-existent key', async () => {
    const app = createTestApp();
    const userId = 'user-1';

    const response = await request(app)
      .delete(`/api/keys/non-existent-id`)
      .set('x-user-id', userId);

    expect(response.status).toBe(204);
  });

  it('should verify API keys correctly', async () => {
    const userId = 'user-1';
    const createResult = apiKeyRepository.create({
      apiId: 'api-1',
      userId,
      scopes: ['read', 'write'],
      rateLimitPerMinute: 100
    });

    // Valid key should verify
    const verifiedKey = apiKeyRepository.verify(createResult.key);
    expect(verifiedKey).toBeTruthy();
    expect(verifiedKey!.userId).toBe(userId);
    expect(verifiedKey!.scopes).toEqual(['read', 'write']);
    expect(verifiedKey!.keyHash).toBe('[REDACTED]');

    // Invalid key should not verify
    expect(apiKeyRepository.verify('invalid_key')).toBeNull();
  });

  it('should rotate API keys securely', async () => {
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
      // Old key should no longer work
      expect(apiKeyRepository.verify(createResult.key)).toBeNull();
      
      // New key should work
      expect(apiKeyRepository.verify(rotateResult.newKey)).toBeTruthy();
      expect(rotateResult.newKey).not.toBe(createResult.key);
    }
  });

  it('should reject rotation for unauthorized users', async () => {
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

  it('returns 403 when trying to revoke a key owned by another user', async () => {
    const app = createTestApp();

    // Create a key for user-2
    apiKeyRepository.create({
      apiId: 'api-1',
      userId: 'user-2',
      scopes: ['*'],
      rateLimitPerMinute: null
    });

    const keys = apiKeyRepository.listForTesting();
    const keyToRevoke = keys.find(k => k.userId === 'user-2')!;

    const response = await request(app)
      .delete(`/api/keys/${keyToRevoke.id}`)
      .set('x-user-id', 'user-1'); // acting as user-1

    expect(response.status).toBe(403);

    // Check it's still there
    const updatedKeys = apiKeyRepository.listForTesting();
    expect(updatedKeys.find(k => k.id === keyToRevoke.id)).toBeDefined();
  });

  it('returns 401 if unauthenticated', async () => {
    const app = createTestApp();
    const response = await request(app).delete('/api/keys/some-id');
    expect(response.status).toBe(401);
  });
});
