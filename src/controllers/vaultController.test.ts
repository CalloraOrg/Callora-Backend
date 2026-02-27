import request from 'supertest';
import express from 'express';
import { VaultController } from './vaultController.js';
import { InMemoryVaultRepository } from '../repositories/vaultRepository.js';
import { errorHandler } from '../middleware/errorHandler.js';

function createTestApp(vaultRepository: InMemoryVaultRepository) {
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

  const vaultController = new VaultController(vaultRepository);
  app.get('/api/vault/balance', vaultController.getBalance.bind(vaultController));

  app.use(errorHandler);
  return app;
}

describe('VaultController - getBalance', () => {
  it('returns 401 when no user is authenticated', async () => {
    const repository = new InMemoryVaultRepository();
    const app = createTestApp(repository);

    const response = await request(app).get('/api/vault/balance');
    expect(response.status).toBe(401);
  });

  it('returns 404 when vault does not exist', async () => {
    const repository = new InMemoryVaultRepository();
    const app = createTestApp(repository);

    const response = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'user-1');

    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Vault not found');
  });

  it('returns 400 for invalid network', async () => {
    const repository = new InMemoryVaultRepository();
    const app = createTestApp(repository);

    const response = await request(app)
      .get('/api/vault/balance?network=invalid')
      .set('x-user-id', 'user-1');

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('network must be either');
  });

  it('returns correctly formatted zero balance', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('user-1', 'contract-123', 'testnet');

    const app = createTestApp(repository);
    const response = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.balance_usdc).toBe('0.0000000');
    expect(response.body.contractId).toBe('contract-123');
    expect(response.body.network).toBe('testnet');
    expect(response.body.lastSyncedAt).toBeNull();
  });

  it('returns correctly formatted positive balance', async () => {
    const repository = new InMemoryVaultRepository();
    const vault = await repository.create('user-2', 'contract-456', 'testnet');
    await repository.updateBalanceSnapshot(vault.id, 15000000n, new Date('2023-01-01T12:00:00Z'));

    const app = createTestApp(repository);
    const response = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'user-2');

    expect(response.status).toBe(200);
    expect(response.body.balance_usdc).toBe('1.5000000');
    expect(response.body.contractId).toBe('contract-456');
    expect(response.body.network).toBe('testnet');
    expect(response.body.lastSyncedAt).toBe('2023-01-01T12:00:00.000Z');
  });

  it('handles different network parameter correctly', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('user-3', 'contract-mainnet', 'mainnet');

    const app = createTestApp(repository);
    const response = await request(app)
      .get('/api/vault/balance?network=mainnet')
      .set('x-user-id', 'user-3');

    expect(response.status).toBe(200);
    expect(response.body.contractId).toBe('contract-mainnet');
    expect(response.body.network).toBe('mainnet');
  });
});
