import { createSorobanVaultReader } from './sorobanVaultReader.js';

const liveTestnet = process.env.SOROBAN_LIVE_TESTNET === '1' ? describe : describe.skip;

liveTestnet('SorobanVaultReader live testnet', () => {
  it('reads the deployed vault without signing or submitting', async () => {
    const reader = createSorobanVaultReader({
      testnet: {
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      },
      mainnet: {
        sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
      },
    });

    const state = await reader.readVault(
      'CBJZLUKQBWDMZPKNJAVONZ7GCCWADSETRXWOPN5Z3XWAUNI4F2R7XDYQ',
      'testnet',
    );

    expect(state.paused).toBe(false);
    expect(state.balance).toBeGreaterThanOrEqual(0n);
  }, 30_000);
});
