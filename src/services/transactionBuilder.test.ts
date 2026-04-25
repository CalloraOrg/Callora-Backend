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
          networkPassphrase: 'Test SDF Network ; September 2015',
          vaultContractId: 'CVAULTTEST',
        },
        mainnet: {
          horizonUrl: 'https://horizon.stellar.org',
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
  SourceAccountNotFoundError,
  TransactionBuildError,
  TransactionBuilderService,
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
  });

  test('builds an unsigned transaction with configured fee and timeout defaults', async () => {
    const service = new TransactionBuilderService();

    const result = await service.buildDepositTransaction({
      userPublicKey: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '12.3456789',
    });

    assert.equal(result.network, 'testnet');
    assert.equal(result.fee, '100');
    assert.equal(result.timeout, 300);
    assert.equal(result.memo, undefined);
    assert.equal(result.operation.args[1]?.value, '123456789');
    assert.equal(result.xdr, 'xdr:100:300:none:CVAULTTEST');
    assert.equal(mockServerConstructor.mock.calls[0]?.[0], 'https://horizon-testnet.stellar.org');
    assert.equal(mockAddMemo.mock.calls.length, 0);
  });

  test('uses the correct network passphrase from configuration', async () => {
    const service = new TransactionBuilderService();

    await service.buildDepositTransaction({
      userPublicKey: 'GUSERPUBLICKEY123',
      vaultContractId: 'CVAULTTEST',
      amountUsdc: '10.0000000',
    });

    // Check that the TransactionBuilder receives the correct options.
    // We check mockBuild which receives the options via the MockTransactionBuilder instance.
    
    // Since I can't easily access arguments of the mock constructor in this setup 
    // because of how MockTransactionBuilder is defined, I'll check mockBuild 
    // which receives the options via the MockTransactionBuilder instance.
    
    const buildCall = mockBuild.mock.calls[0]?.[0];
    assert.equal(buildCall.options.networkPassphrase, 'Test SDF Network ; September 2015');
  });

  test('supports explicit fee, timeout, and text memo values', async () => {
    const service = new TransactionBuilderService({
      baseFee: 250,
      timeoutSeconds: 600,
    });

    const result = await service.buildDepositTransaction({
      userPublicKey: 'GUSERPUBLICKEY123',
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
        userPublicKey: 'GUSERPUBLICKEY123',
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
        userPublicKey: 'GUSERPUBLICKEY123',
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
        userPublicKey: 'GUSERPUBLICKEY123',
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
        userPublicKey: 'GUSERPUBLICKEY123',
        sourceAccount: 'GSOURCEACCOUNT123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      SourceAccountNotFoundError
    );
  });

  test('maps Horizon transport failures to NetworkError', async () => {
    // mockRejectedValue (not Once) so all retry attempts fail
    const service = new TransactionBuilderService({ maxRetries: 0 });
    mockLoadAccount.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    await assert.rejects(
      service.buildDepositTransaction({
        userPublicKey: 'GUSERPUBLICKEY123',
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
      userPublicKey: 'GUSERPUBLICKEY123',
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
        userPublicKey: 'GUSERPUBLICKEY123',
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
        userPublicKey: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      TransactionBuildError
    );
  });

  test('rejects invalid fee or timeout overrides', async () => {
    const badFeeService = new TransactionBuilderService({ baseFee: '0' });
    const badTimeoutService = new TransactionBuilderService({ timeoutSeconds: 0 });

    await assert.rejects(
      badFeeService.buildDepositTransaction({
        userPublicKey: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      TransactionBuildError
    );

    await assert.rejects(
      badTimeoutService.buildDepositTransaction({
        userPublicKey: 'GUSERPUBLICKEY123',
        vaultContractId: 'CVAULTTEST',
        amountUsdc: '1.0000000',
      }),
      TransactionBuildError
    );
  });
});
