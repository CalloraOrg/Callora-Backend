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

  it('defaults to testnet when network is omitted', () => {
    expect(parseNetworkWithDefault({})).toBe('testnet');
    expect(parseNetworkWithDefault({ network: undefined })).toBe('testnet');
  });
});
