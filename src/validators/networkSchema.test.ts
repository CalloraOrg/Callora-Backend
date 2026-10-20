import { parseNetworkWithDefault, stellarNetworkQuerySchema } from './networkSchema.js';

describe('networkSchema', () => {
  it('accepts testnet and mainnet', () => {
    expect(stellarNetworkQuerySchema.parse({ network: 'testnet' })).toEqual({
      network: 'testnet',
    });
    expect(stellarNetworkQuerySchema.parse({ network: 'mainnet' })).toEqual({
      network: 'mainnet',
    });
  });

  it('rejects invalid network values', () => {
    expect(() => stellarNetworkQuerySchema.parse({ network: 'invalid' })).toThrow();
    expect(() => stellarNetworkQuerySchema.parse({ network: '' })).toThrow();
  });

  it('defaults to the configured network when network is omitted', () => {
    expect(parseNetworkWithDefault({})).toBe('testnet');
    expect(parseNetworkWithDefault({ network: undefined })).toBe('testnet');
    expect(parseNetworkWithDefault({}, 'mainnet')).toBe('mainnet');
  });

  it('uses STELLAR_NETWORK=mainnet when the network query is omitted', async () => {
    const previousNetwork = process.env.STELLAR_NETWORK;
    try {
      process.env.STELLAR_NETWORK = 'mainnet';
      jest.resetModules();
      const configuredSchema = await import('./networkSchema.js');
      expect(configuredSchema.parseNetworkWithDefault({})).toBe('mainnet');
    } finally {
      if (previousNetwork === undefined) delete process.env.STELLAR_NETWORK;
      else process.env.STELLAR_NETWORK = previousNetwork;
      jest.resetModules();
    }
  });
});
