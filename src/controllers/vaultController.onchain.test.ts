import request from 'supertest';
import { config } from '../config/index.js';
import { InMemoryVaultRepository } from '../repositories/vaultRepository.js';
import type { VaultStateReader } from '../services/sorobanVaultReader.js';
import { createApp, state } from '../../tests/helpers/vaultControllerHarness.js';

describe('vault on-chain controller behavior', () => {
  it('refreshes and persists a snapshot older than the configured maximum age', async () => {
    const repository = new InMemoryVaultRepository();
    const vault = await repository.create('refresh-user', 'vault-contract', 'testnet');
    const reader: VaultStateReader = {
      readVault: jest.fn(async () => state),
    };
    const app = createApp(repository, reader);

    const response = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'refresh-user');
    const persisted = await repository.findByUserId('refresh-user', 'testnet');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      balance_usdc: '0.1234567',
      contractId: vault.contractId,
      network: 'testnet',
      stale: false,
    });
    expect(response.body.data.lastSyncedAt).toEqual(expect.any(String));
    expect(reader.readVault).toHaveBeenCalledWith('vault-contract', 'testnet');
    expect(persisted?.balanceSnapshot).toBe(state.balance);
    expect(persisted?.lastSyncedAt).not.toBeNull();
  });

  it('serves stale cached data with HTTP 200 when Soroban fails', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('stale-user', 'vault-contract', 'testnet');
    const reader: VaultStateReader = {
      readVault: jest.fn(async () => {
        throw new Error('RPC unavailable');
      }),
    };
    const app = createApp(repository, reader);

    const response = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'stale-user');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      balance_usdc: '0.0000000',
      stale: true,
      lastSyncedAt: null,
    });
  });

  it('requires an authenticated user and an existing vault for balance reads', async () => {
    const app = createApp(new InMemoryVaultRepository(), {
      readVault: jest.fn(async () => state),
    });
    const unauthorized = await request(app).get('/api/vault/balance');
    const missingVault = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'missing-balance-user');

    expect(unauthorized.status).toBe(401);
    expect(missingVault.status).toBe(404);
  });

  it('does not refresh a snapshot within the maximum age', async () => {
    const repository = new InMemoryVaultRepository();
    const vault = await repository.create('fresh-user', 'vault-contract', 'testnet');
    await repository.updateBalanceSnapshot(vault.id, 5_000_000n, new Date());
    const reader: VaultStateReader = {
      readVault: jest.fn(async () => state),
    };
    const app = createApp(repository, reader);

    const response = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'fresh-user');

    expect(response.status).toBe(200);
    expect(response.body.data.balance_usdc).toBe('0.5000000');
    expect(response.body.data.stale).toBe(false);
    expect(reader.readVault).not.toHaveBeenCalled();
  });

  it('returns all on-chain view values as exact seven-decimal strings', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('onchain-user', 'vault-contract', 'testnet');
    const reader: VaultStateReader = {
      readVault: jest.fn(async () => state),
    };
    const app = createApp(repository, reader);

    const response = await request(app)
      .get('/api/vault/onchain')
      .set('x-user-id', 'onchain-user');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      contractId: 'vault-contract',
      network: 'testnet',
      balanceUsdc: '0.1234567',
      maxDeductUsdc: '2.3456789',
      paused: true,
      usdcToken: 'GUSDC',
      settlement: 'GSETTLEMENT',
      ledger: 987654,
    });
  });

  it('requires authentication for the on-chain endpoint outside demo mode', async () => {
    const repository = new InMemoryVaultRepository();
    const reader: VaultStateReader = {
      readVault: jest.fn(async () => state),
    };
    const app = createApp(repository, reader);

    const response = await request(app).get('/api/vault/onchain');

    expect(response.status).toBe(401);
    expect(reader.readVault).not.toHaveBeenCalled();
  });

  it('returns 404 when the authenticated caller has no vault', async () => {
    const app = createApp(new InMemoryVaultRepository(), {
      readVault: jest.fn(async () => state),
    });

    const response = await request(app)
      .get('/api/vault/onchain')
      .set('x-user-id', 'missing-user');

    expect(response.status).toBe(404);
  });

  it('returns a configured testnet vault to anonymous demo requests', async () => {
    const demoMode = jest.replaceProperty(config, 'demoMode', true);
    try {
      const reader: VaultStateReader = {
        readVault: jest.fn(async () => state),
      };
      const app = createApp(
        new InMemoryVaultRepository(),
        reader,
        60_000,
        'configured-testnet-vault',
      );
      const response = await request(app).get('/api/vault/onchain');

      expect(response.status).toBe(200);
      expect(response.body.data.contractId).toBe('configured-testnet-vault');
      expect(response.body.data.network).toBe('testnet');
      expect(reader.readVault).toHaveBeenCalledWith(
        'configured-testnet-vault',
        'testnet',
      );
    } finally {
      demoMode.restore();
    }
  });

  it('returns a handled error when the reader is not configured', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('missing-reader-user', 'vault-contract', 'testnet');
    const app = createApp(repository);

    const response = await request(app)
      .get('/api/vault/onchain')
      .set('x-user-id', 'missing-reader-user');

    expect(response.status).toBe(500);
  });

  it('maps unexpected on-chain RPC failures to the standard error response', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('onchain-error-user', 'vault-contract', 'testnet');
    const app = createApp(repository, {
      readVault: async () => {
        throw new Error('RPC unavailable');
      },
    });

    const response = await request(app)
      .get('/api/vault/onchain')
      .set('x-user-id', 'onchain-error-user');

    expect(response.status).toBe(500);
  });

  it('maps unexpected repository and reader failures to the standard error response', async () => {
    const repository = new InMemoryVaultRepository();
    repository.findByUserId = async () => {
      throw new Error('database unavailable');
    };
    const failingReader: VaultStateReader = {
      readVault: async () => {
        throw new Error('RPC unavailable');
      },
    };
    const app = createApp(repository, failingReader);

    const balanceResponse = await request(app)
      .get('/api/vault/balance')
      .set('x-user-id', 'failure-user');
    const onchainResponse = await request(app)
      .get('/api/vault/onchain')
      .set('x-user-id', 'failure-user');

    expect(balanceResponse.status).toBe(500);
    expect(onchainResponse.status).toBe(500);
  });

  it('uses the configured network default and respects explicit overrides', async () => {
    const repository = new InMemoryVaultRepository();
    await repository.create('main-user', 'main-contract', 'mainnet');
    const reader: VaultStateReader = {
      readVault: jest.fn(async () => state),
    };
    const app = createApp(repository, reader);

    const response = await request(app)
      .get('/api/vault/onchain')
      .query({ network: 'mainnet' })
      .set('x-user-id', 'main-user');

    expect(response.status).toBe(200);
    expect(response.body.data.network).toBe('mainnet');
    expect(reader.readVault).toHaveBeenCalledWith('main-contract', 'mainnet');
  });
});
