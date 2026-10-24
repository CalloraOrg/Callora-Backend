import assert from 'node:assert/strict';

const mockServerConstructor = jest.fn();
const mockLoadAccount = jest.fn();
const mockInvokeContractFunction = jest.fn();
const mockNativeToScVal = jest.fn((value: unknown, options: unknown) => ({
  value,
  options,
}));
const mockMemoText = jest.fn((value: string) => ({
  type: 'text',
  value,
}));
const mockAddOperation = jest.fn();
const mockAddMemo = jest.fn();
const mockSetTimeout = jest.fn();
const mockBuild = jest.fn();

const mockSimulateTransaction = jest.fn();
const mockPrepareTransaction = jest.fn();

class MockAddress {
  constructor(private readonly value: string) {
    if (typeof value !== 'string' || value.trim() === '' || value.startsWith('BAD')) {
      throw new Error(`invalid address: ${value}`);
    }
  }

  toString(): string {
    return this.value;
  }
}

class MockServer {
  constructor(url: string) {
    mockServerConstructor(url);
  }

  loadAccount(accountId: string) {
    return mockLoadAccount(accountId);
  }
}

class MockTransactionBuilder {
  private operation: unknown;
  private memo: { type: 'text'; value: string } | undefined;
  private timeout: number | undefined;

  constructor(
    private readonly sourceAccount: unknown,
    private readonly options: { fee: string; networkPassphrase: string }
  ) {}

  addOperation(operation: unknown): this {
    mockAddOperation(operation);
    this.operation = operation;
    return this;
  }

  addMemo(memo: { type: 'text'; value: string }): this {
    mockAddMemo(memo);
    this.memo = memo;
    return this;
  }

  setTimeout(timeout: number): this {
    mockSetTimeout(timeout);
    this.timeout = timeout;
    return this;
  }

  build() {
    return mockBuild({
      sourceAccount: this.sourceAccount,
      options: this.options,
      operation: this.operation,
      memo: this.memo,
      timeout: this.timeout,
    });
  }
}

class MockRpcServer {
  constructor(url: string, options: unknown) {
    // Store for verification
  }

  simulateTransaction(tx: unknown) {
    return mockSimulateTransaction(tx);
  }

  prepareTransaction(tx: unknown, simulationResult: unknown) {
    return mockPrepareTransaction(tx, simulationResult);
  }
}

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: MockServer,
  },
  TransactionBuilder: MockTransactionBuilder,
  Operation: {
    invokeContractFunction: mockInvokeContractFunction,
  },
  Address: MockAddress,
  Memo: {
    text: mockMemoText,
  },
  nativeToScVal: mockNativeToScVal,
  rpc: {
    Server: MockRpcServer,
    Api: {
      isSimulationSuccess: (result: { error?: unknown }) => !result.error,
    },
  },
}));

jest.mock('../config/index.js', () => ({
  config: {
    stellar: {
      network: 'testnet',
      baseFee: '100',
      transactionTimeout: 300,
      networks: {
        testnet: {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          sorobanRpcUrl: 'https://soroban-testnet.stellar.org:443',
          networkPassphrase: 'Test SDF Network ; September 2015',
          vaultContractId: 'CVAULTTEST',
        },
        mainnet: {
          horizonUrl: 'https://horizon.stellar.org',
          sorobanRpcUrl: 'https://soroban-mainnet.stellar.org:443',
          networkPassphrase: 'Public Global Stellar Network ; September 2015',
          vaultContractId: 'CVAULTMAIN',
        },
      },
    },
  },
}));

import {
  InvalidAmountError,
  InvalidMemoError,
  NetworkError,
  SimulationError,
  SourceAccountNotFoundError,
  TransactionBuildError,
  TransactionBuilderService,
  StellarAddressRequiredError,
} from './transactionBuilder.js';

describe('TransactionBuilderService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockLoadAccount.mockResolvedValue({
      accountId: 'GSOURCEACCOUNT123',
      sequence: '1',
    });

    mockInvokeContractFunction.mockImplementation((input: Record<string, unknown>) => ({
      kind: 'invokeContractFunction',
      ...input,
    }));

    mockBuild.mockImplementation(({
      options,
      operation,
      memo,
      timeout,
    }: {
      options: { fee: string };
      operation: { contract: string };
      memo?: { value: string };
      timeout: number;
    }) => ({
      signatures: [],
      toXDR: () =>
        `xdr:${options.fee}:${timeout}:${memo?.value ?? 'none'}:${String(operation.contract)}`,
    }));

    mockSimulateTransaction.mockResolvedValue({
      result: {
        retval: 'success',
      },
      events: [],
      footprint: { readOnly: [], readWrite: [] },
      latestLedger: 12345678,
      minResourceFee: '100000',
    });

    mockPrepareTransaction.mockResolvedValue({
      transaction: {
        signatures: [],
        toXDR: () => 'prepared-xdr-with-soroban-data',
      },
      resourceFee: '123456',
      minResourceFee: '100000',
      latestLedger: 12345678,
    });
  });

  test('builds an unsigned transaction with configured fee and timeout defaults', async () => {
    const service = new TransactionBuilderService();

    const result = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '12.3456789',
    });

    assert.equal(result.network, 'testnet');
    assert.equal(result.fee, '100');
    assert.equal(result.timeout, 300);
    assert.equal(result.resourceFee, '123456');
    assert.equal(result.minResourceFee, '100000');
    assert.equal(result.latestLedger, 12345678);
    assert.equal(result.memo, undefined);
    assert.equal(result.operation.args[1]?.value, '123456789');
    assert.equal(result.xdr, 'prepared-xdr-with-soroban-data');
    assert.equal(mockServerConstructor.mock.calls[0]?.[0], 'https://horizon-testnet.stellar.org');
    assert.equal(mockAddMemo.mock.calls.length, 0);
    // Verify simulateTransaction and prepareTransaction were called
    assert.equal(mockSimulateTransaction.mock.calls.length, 1);
    assert.equal(mockPrepareTransaction.mock.calls.length, 1);
  });

  test('uses a durable reserved sequence when a sequence store is configured for backend account', async () => {
    const sequenceStore = {
      allocate: jest.fn().mockResolvedValue(9n),
    };
    const service = new TransactionBuilderService({ 
      sequenceStore,
      isBackendOwnedAccount: () => true,
    });

    await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '12.3456789',
    });

    assert.deepEqual(sequenceStore.allocate.mock.calls[0], ['GUSERPUBLICKEY123', 2n]);
    assert.equal(mockBuild.mock.calls[0]?.[0].sourceAccount.sequence, '8');
  });

  test('does not use sequence store for user-owned accounts', async () => {
    const sequenceStore = {
      allocate: jest.fn().mockResolvedValue(9n),
    };
    const service = new TransactionBuilderService({ 
      sequenceStore,
      isBackendOwnedAccount: () => false,
    });

    await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '12.3456789',
    });

    // Sequence store should not be called for user-owned accounts
    assert.equal(sequenceStore.allocate.mock.calls.length, 0);
  });

  test('returns an explicit recoverable network error when durable sequence allocation fails', async () => {
    const service = new TransactionBuilderService({
      sequenceStore: {
        allocate: jest.fn().mockRejectedValue(new Error('database unavailable')),
      },
      isBackendOwnedAccount: () => true,
    });

    await expect(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '12.3456789',
      })
    ).rejects.toThrow(NetworkError);
  });

  test('uses the correct network passphrase from configuration', async () => {
    const service = new TransactionBuilderService();

    await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '10.0000000',
    });

    const buildCall = mockBuild.mock.calls[0]?.[0];
    assert.equal(buildCall.options.networkPassphrase, 'Test SDF Network ; September 2015');
  });

  test('supports explicit fee, timeout, and text memo values', async () => {
    const service = new TransactionBuilderService({
      baseFee: 250,
      timeoutSeconds: 600,
    });

    const result = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
      memoText: ' deposit ',
    });

    assert.equal(result.fee, '250');
    assert.equal(result.timeout, 600);
    assert.deepEqual(result.memo, {
      type: 'text',
      value: 'deposit',
    });
    assert.equal(mockMemoText.mock.calls[0]?.[0], 'deposit');
    assert.equal(mockAddMemo.mock.calls[0]?.[0]?.value, 'deposit');
  });

  test('rejects malformed USDC amounts before touching the SDK', async () => {
    const service = new TransactionBuilderService();

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1e7',
      }),
      InvalidAmountError
    );

    assert.equal(mockLoadAccount.mock.calls.length, 0);
  });

  test('rejects amounts above the maximum supported USDC limit', async () => {
    const service = new TransactionBuilderService();

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1000000001.0000000',
      }),
      InvalidAmountError
    );
  });

  test('rejects memos longer than 28 bytes', async () => {
    const service = new TransactionBuilderService();

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
        memoText: '12345678901234567890123456789',
      }),
      InvalidMemoError
    );
  });

  test('maps Horizon 404-style account failures to SourceAccountNotFoundError', async () => {
    const service = new TransactionBuilderService();
    mockLoadAccount.mockRejectedValueOnce(new Error('404 Resource Missing'));

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        sourceAccount: 'GSOURCEACCOUNT123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      SourceAccountNotFoundError
    );
  });

  test('maps Horizon transport failures to NetworkError', async () => {
    const service = new TransactionBuilderService({ maxRetries: 0 });
    mockLoadAccount.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        sourceAccount: 'GSOURCEACCOUNT123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      NetworkError
    );
  });

  test('retries transient Horizon errors and succeeds on second attempt', async () => {
    const service = new TransactionBuilderService({ maxRetries: 1, retryBaseDelayMs: 0 });
    mockLoadAccount
      .mockRejectedValueOnce(new Error('connect ETIMEDOUT'))
      .mockResolvedValueOnce({ accountId: 'GSOURCEACCOUNT123', sequence: '1' });

    const result = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    });

    assert.equal(result.network, 'testnet');
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
  });

  test('does not retry Horizon 404 account-not-found errors', async () => {
    const service = new TransactionBuilderService({ maxRetries: 3, retryBaseDelayMs: 0 });
    mockLoadAccount.mockRejectedValue(new Error('404 Resource Missing'));

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      SourceAccountNotFoundError
    );
    // 404 is permanent — single attempt only
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  test('maps transaction builder failures to TransactionBuildError', async () => {
    const service = new TransactionBuilderService();
    mockBuild.mockImplementationOnce(() => {
      throw new Error('invalid sequence number');
    });

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      TransactionBuildError
    );
  });

  test('captures structured simulation diagnostics from SDK failures', async () => {
    const service = new TransactionBuilderService();
    mockInvokeContractFunction.mockImplementationOnce(() => {
      throw Object.assign(new Error('simulation rejected'), {
        details: {
          result: {
            error: { code: 'tx_failed', message: 'host function failed' },
            events: [{ type: 'diagnostic', address: 'GUSERPUBLICKEY123' }],
            footprint: { readOnly: ['contract-data'], balance: '100' },
          },
        },
      });
    });

    const error = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    }).catch((err) => err);

    assert.ok(error instanceof SimulationError);
    assert.deepEqual(error.simulationDetails, {
      errorCode: 'tx_failed',
      errorMessage: 'host function failed',
      events: [{ type: 'diagnostic', address: '[REDACTED]' }],
      footprint: { readOnly: ['contract-data'], balance: '[REDACTED]' },
    });
  });

  test('captures malformed simulation diagnostics safely', async () => {
    const service = new TransactionBuilderService();
    mockInvokeContractFunction.mockImplementationOnce(() => {
      throw Object.assign(new Error('simulation rejected'), {
        details: 'bad rpc payload',
      });
    });

    const error = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    }).catch((err) => err);

    assert.ok(error instanceof SimulationError);
    assert.deepEqual(error.simulationDetails, {
      errorMessage: 'bad rpc payload',
    });
  });

  test('handles Soroban simulation failure (non-success result)', async () => {
    const service = new TransactionBuilderService();
    mockSimulateTransaction.mockResolvedValueOnce({
      error: 'BelowMinDeposit',
      errorCode: 8,
    });

    const error = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    }).catch((err) => err);

    assert.ok(error instanceof SimulationError);
    assert.equal(error.simulationDetails.errorCode, 8);
    assert.equal(error.simulationDetails.errorMessage, 'BelowMinDeposit');
  });

  test('handles prepareTransaction failure', async () => {
    const service = new TransactionBuilderService();
    mockPrepareTransaction.mockRejectedValueOnce(new Error('prepare failed'));

    const error = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    }).catch((err) => err);

    assert.ok(error instanceof SimulationError);
    assert.ok(error.message.includes('prepareTransaction failed'));
  });

  test('retries transient RPC errors during simulation', async () => {
    const service = new TransactionBuilderService({ maxRetries: 1, retryBaseDelayMs: 0 });
    mockSimulateTransaction
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        result: { retval: 'success' },
        events: [],
        footprint: { readOnly: [], readWrite: [] },
        latestLedger: 12345678,
        minResourceFee: '100000',
      });

    const result = await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    });

    assert.equal(result.network, 'testnet');
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  test('does not retry permanent RPC errors during simulation', async () => {
    const service = new TransactionBuilderService({ maxRetries: 3, retryBaseDelayMs: 0 });
    mockSimulateTransaction.mockRejectedValue(new Error('404 not found'));

    await assert.rejects(
      service.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      SimulationError
    );
    // Should not retry 404
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid fee or timeout overrides', async () => {
    const badFeeService = new TransactionBuilderService({ baseFee: '0' });
    const badTimeoutService = new TransactionBuilderService({ timeoutSeconds: 0 });

    await assert.rejects(
      badFeeService.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      TransactionBuildError
    );

    await assert.rejects(
      badTimeoutService.buildDepositTransaction({
        userStellarAddress: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      TransactionBuildError
    );
  });

  test('uses custom RPC server when provided', async () => {
    const customRpcServer = new MockRpcServer('custom-url', {});
    const createRpcServer = jest.fn().mockReturnValue(customRpcServer);
    const service = new TransactionBuilderService({ createRpcServer });

    await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    });

    assert.equal(createRpcServer.mock.calls[0]?.[0], 'https://soroban-testnet.stellar.org:443');
  });

  test('uses custom Horizon server when provided', async () => {
    const customServer = new MockServer('custom-horizon-url');
    const createServer = jest.fn().mockReturnValue(customServer);
    const service = new TransactionBuilderService({ createServer });

    await service.buildDepositTransaction({
      userStellarAddress: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '1.0000000',
    });

    assert.equal(createServer.mock.calls[0]?.[0], 'https://horizon-testnet.stellar.org');
  });
});