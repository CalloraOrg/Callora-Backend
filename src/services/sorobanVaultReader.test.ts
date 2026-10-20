import { Address, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import {
  SorobanVaultReader,
  createSorobanVaultReader,
  type OnchainVaultState,
} from './sorobanVaultReader.js';

const contractId =
  'CBJZLUKQBWDMZPKNJAVONZ7GCCWADSETRXWOPN5Z3XWAUNI4F2R7XDYQ';
const tokenId =
  'CAC7CFZ42L3LTTZCI4C3XI6UF7AHS2PYTNJ5QEG2PSLRGDGMWRQOZOT5';
const settlementId =
  'CB4BUGCX5LFS5KYWAO2J4ZQTALOQSGXFFAOVKKGAS32OFZLU7O7YYGHS';

function setupReader(
  simulateTransaction: jest.Mock,
  timeoutMs = 2_000,
): SorobanVaultReader {
  const server = { simulateTransaction } as unknown as InstanceType<
    typeof rpc.Server
  >;
  return new SorobanVaultReader(
    () => server,
    {
      testnet: 'Test SDF Network ; September 2015',
      mainnet: 'Public Global Stellar Network ; September 2015',
    },
    10_000,
    timeoutMs,
  );
}

function successfulSimulations(
  returnValues = [
    nativeToScVal(1_234_567n, { type: 'i128' }),
    nativeToScVal(50_000_000n, { type: 'i128' }),
    nativeToScVal(false, { type: 'bool' }),
    nativeToScVal(new Address(tokenId), { type: 'address' }),
    nativeToScVal(new Address(settlementId), { type: 'address' }),
  ],
): jest.Mock {
  let index = 0;
  return jest.fn(async () => ({
    result: { retval: returnValues[index++ % returnValues.length] },
    latestLedger: 500,
  }));
}

describe('SorobanVaultReader', () => {
  test('simulates and decodes all deployed vault views', async () => {
    const simulate = successfulSimulations();
    const reader = setupReader(simulate);

    const result = await reader.readVault(contractId, 'testnet');

    expect(result).toEqual<OnchainVaultState>({
      balance: 1_234_567n,
      maxDeduct: 50_000_000n,
      paused: false,
      usdcToken: tokenId,
      settlement: settlementId,
      ledger: 500,
    });
    expect(simulate).toHaveBeenCalledTimes(5);
    expect(simulate.mock.calls.every(([transaction]) =>
      transaction.signatures.length === 0,
    )).toBe(true);
    await reader.readVault(contractId, 'testnet');
    expect(simulate).toHaveBeenCalledTimes(5);
  });

  test('coalesces concurrent requests into one simulation per view and caches the result', async () => {
    const simulate = successfulSimulations();
    const reader = setupReader(simulate);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => reader.readVault(contractId, 'testnet')),
    );

    expect(simulate).toHaveBeenCalledTimes(5);
    expect(results.every((result) => result.balance === 1_234_567n)).toBe(true);
  });

  test('does not cache failed simulations', async () => {
    const simulate = jest.fn(async () => ({ error: 'contract missing' }));
    const reader = setupReader(simulate);

    await expect(reader.readVault(contractId, 'testnet')).rejects.toThrow(
      'Vault balance simulation failed: contract missing',
    );
    await expect(reader.readVault(contractId, 'testnet')).rejects.toThrow();
    expect(simulate).toHaveBeenCalledTimes(10);
  });

  test('bounds each simulation by the configured timeout', async () => {
    const simulate = jest.fn(
      () => new Promise<never>(() => undefined),
    );
    const reader = setupReader(simulate, 5);

    await expect(reader.readVault(contractId, 'testnet')).rejects.toThrow(
      'Soroban vault RPC request timed out.',
    );
    expect(simulate).toHaveBeenCalledTimes(5);
  });

  test('accepts safe integer results and string-encoded addresses', async () => {
    const simulate = successfulSimulations([
      nativeToScVal(123, { type: 'i32' }),
      nativeToScVal(456, { type: 'i32' }),
      nativeToScVal(false, { type: 'bool' }),
      nativeToScVal(tokenId, { type: 'string' }),
      nativeToScVal(settlementId, { type: 'string' }),
    ]);
    const result = await setupReader(simulate).readVault(contractId, 'mainnet');

    expect(result.balance).toBe(123n);
    expect(result.maxDeduct).toBe(456n);
    expect(result.usdcToken).toBe(tokenId);
    expect(result.settlement).toBe(settlementId);
  });

  test('rejects malformed view return values and missing simulation results', async () => {
    const invalidPause = successfulSimulations([
      nativeToScVal(1n, { type: 'i128' }),
      nativeToScVal(2n, { type: 'i128' }),
      nativeToScVal(1, { type: 'i32' }),
      nativeToScVal(new Address(tokenId), { type: 'address' }),
      nativeToScVal(new Address(settlementId), { type: 'address' }),
    ]);
    await expect(
      setupReader(invalidPause).readVault(contractId, 'testnet'),
    ).rejects.toThrow('is_paused view returned a non-boolean');

    const missingResult = jest.fn(async () => ({ latestLedger: 100 }));
    await expect(
      setupReader(missingResult).readVault(contractId, 'testnet'),
    ).rejects.toThrow('simulation returned no result');

    const invalidInteger = successfulSimulations([
      nativeToScVal(true, { type: 'bool' }),
      nativeToScVal(2n, { type: 'i128' }),
      nativeToScVal(false, { type: 'bool' }),
      nativeToScVal(new Address(tokenId), { type: 'address' }),
      nativeToScVal(new Address(settlementId), { type: 'address' }),
    ]);
    await expect(
      setupReader(invalidInteger).readVault(contractId, 'testnet'),
    ).rejects.toThrow('balance view returned an invalid integer');

    const invalidAddress = successfulSimulations([
      nativeToScVal(1n, { type: 'i128' }),
      nativeToScVal(2n, { type: 'i128' }),
      nativeToScVal(false, { type: 'bool' }),
      nativeToScVal(new Address(tokenId), { type: 'address' }),
      nativeToScVal(true, { type: 'bool' }),
    ]);
    await expect(
      setupReader(invalidAddress).readVault(contractId, 'testnet'),
    ).rejects.toThrow('get_settlement view returned an invalid address');
  });

  test('expires cached data and reuses the configured network server', async () => {
    const simulate = successfulSimulations();
    const server = {
      simulateTransaction: simulate,
    } as unknown as InstanceType<typeof rpc.Server>;
    const createServer = jest.fn(() => server);
    const reader = createSorobanVaultReader(
      {
        testnet: {
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
          networkPassphrase: 'Test SDF Network ; September 2015',
        },
        mainnet: {
          sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
          networkPassphrase: 'Public Global Stellar Network ; September 2015',
        },
      },
      2_000,
      createServer,
    );

    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await reader.readVault(contractId, 'testnet');
      now.mockReturnValue(11_001);
      await reader.readVault(contractId, 'testnet');
    } finally {
      now.mockRestore();
    }
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledTimes(10);
  });
});
