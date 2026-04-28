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
      STELLAR_TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_TESTNET_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
      SOROBAN_MAINNET_RPC_URL: 'https://soroban-mainnet.stellar.org',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const getPassphrase = async () => {
    const { config } = await import('../index.js');
    return config.stellar.networkPassphrase;
  };

  const getStellarUrls = async () => {
    const { config } = await import('../index.js');
    return {
      horizonUrl: config.stellar.horizonUrl,
      sorobanRpcUrl: config.stellar.sorobanRpcUrl,
    };
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

  it('accepts HTTPS Stellar endpoints', async () => {
    const urls = await getStellarUrls();
    expect(urls).toEqual({
      horizonUrl: 'https://horizon-testnet.stellar.org/',
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org/',
    });
  });

  it('allows localhost HTTP Stellar endpoints for local development', async () => {
    process.env.STELLAR_TESTNET_HORIZON_URL = 'http://localhost:8000';
    process.env.SOROBAN_TESTNET_RPC_URL = 'http://127.0.0.1:9000/rpc';

    const urls = await getStellarUrls();
    expect(urls).toEqual({
      horizonUrl: 'http://localhost:8000/',
      sorobanRpcUrl: 'http://127.0.0.1:9000/rpc',
    });
  });

  it('rejects non-HTTPS remote Stellar endpoints', async () => {
    process.env.STELLAR_TESTNET_HORIZON_URL = 'http://stellar.example.com';

    await expect(import('../index.js')).rejects.toThrow(
      'STELLAR_TESTNET_HORIZON_URL must use HTTPS unless it targets localhost for local development.'
    );
  });

  it('rejects embedded credentials in Stellar endpoints', async () => {
    process.env.SOROBAN_TESTNET_RPC_URL = 'https://user:secret@soroban-testnet.stellar.org';

    await expect(import('../index.js')).rejects.toThrow(
      'SOROBAN_TESTNET_RPC_URL must not include embedded credentials.'
    );
  });

  it('rejects query strings in Stellar endpoints', async () => {
    process.env.SOROBAN_MAINNET_RPC_URL = 'https://soroban-mainnet.stellar.org?token=abc';

    await expect(import('../index.js')).rejects.toThrow(
      'SOROBAN_MAINNET_RPC_URL must not include query strings or fragments.'
    );
  });
});
