import type { HealthCheckConfig } from './healthCheck.js';

export function mockSorobanRpc(
  options: { healthError?: Error; delayMs?: number } = {},
): NonNullable<HealthCheckConfig['sorobanRpc']> {
  return {
    url: 'https://soroban-test.stellar.org',
    timeout: 2_000,
    networkPassphrase: 'Test SDF Network ; September 2015',
    vaultContractId: '',
    createServer: () => ({
      getHealth: async () => {
        if (options.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        if (options.healthError) throw options.healthError;
        return { status: 'healthy' };
      },
      getNetwork: async () => ({
        passphrase: 'Test SDF Network ; September 2015',
      }),
      getLedgerEntries: async () => ({ entries: [] }),
    }),
  };
}
