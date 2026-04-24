import { jest } from '@jest/globals';

describe('Configuration Network Passphrase', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { 
      ...originalEnv,
      JWT_SECRET: 'test-secret',
      ADMIN_API_KEY: 'test-admin-key',
      METRICS_API_KEY: 'test-metrics-key',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const getPassphrase = async () => {
    const { config } = await import('../index.js');
    return config.stellar.networkPassphrase;
  };

  it('should use testnet passphrase by default', async () => {
    process.env.STELLAR_NETWORK = 'testnet';
    const passphrase = await getPassphrase();
    expect(passphrase).toBe('Test SDF Network ; September 2015');
  });

  it('should use mainnet passphrase when STELLAR_NETWORK is mainnet', async () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    const passphrase = await getPassphrase();
    expect(passphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('should respect SOROBAN_NETWORK as a fallback for network selection', async () => {
    delete process.env.STELLAR_NETWORK;
    process.env.SOROBAN_NETWORK = 'mainnet';
    const passphrase = await getPassphrase();
    expect(passphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('should prioritize STELLAR_NETWORK over SOROBAN_NETWORK', async () => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.SOROBAN_NETWORK = 'mainnet';
    const passphrase = await getPassphrase();
    expect(passphrase).toBe('Test SDF Network ; September 2015');
  });
});
