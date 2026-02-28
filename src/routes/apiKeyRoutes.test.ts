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
    // Assuming we can clear it or we just create unique keys.
    // The repository doesn't have a built-in clear method, so we will
    // just interact with unique keys per test.
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
