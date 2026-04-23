/**
 * Smoke tests for TransactionBuilderService.buildDepositTransaction
 *
 * These tests extend the existing suite to cover additional success and
 * failure paths not exercised elsewhere. All Stellar SDK I/O is replaced
 * with lightweight in-process fakes so no network calls are made.
 *
 * Security / data-integrity assumptions:
 *  - Address validation is delegated to the Stellar SDK (mocked via MockAddress).
 *  - Amount conversion is pure arithmetic — no floating-point rounding occurs
 *    because the regex gate enforces exactly 7 decimal places before any math.
 *  - The vault contract ID is validated against the configured value; a mismatch
 *    is a hard rejection to prevent cross-environment fund routing.
 *  - Cross-network requests (e.g. sending a mainnet contract ID to a testnet
 *    deployment) are rejected before any account load is attempted.
 */

import assert from 'node:assert/strict';

// ─── Stellar SDK mocks ────────────────────────────────────────────────────────

const mockServerConstructor = jest.fn();
const mockLoadAccount = jest.fn();
const mockInvokeContractFunction = jest.fn();
const mockNativeToScVal = jest.fn((value: unknown, options: unknown) => ({
  value,
  options,
}));
const mockMemoText = jest.fn((value: string) => ({ type: 'text', value }));
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

  addOperation(op: unknown): this {
    mockAddOperation(op);
    this.operation = op;
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
  Horizon: { Server: MockServer },
  TransactionBuilder: MockTransactionBuilder,
  Operation: { invokeContractFunction: mockInvokeContractFunction },
  Address: MockAddress,
  Memo: { text: mockMemoText },
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

  InvalidStellarAddressError,
  NetworkError,
  TransactionBuilderService,
} from './transactionBuilder.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_USER_KEY = 'GUSERPUBLICKEY123';
const VALID_VAULT = 'CVAULTTEST';
const VALID_AMOUNT = '1.0000000';

function makeService(overrides = {}) {
  return new TransactionBuilderService(overrides);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('TransactionBuilderService — smoke tests (extended)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockLoadAccount.mockResolvedValue({
      accountId: VALID_USER_KEY,
      sequence: '1',
    });

    mockInvokeContractFunction.mockImplementation((input: Record<string, unknown>) => ({
      kind: 'invokeContractFunction',
      ...input,
    }));

    mockBuild.mockImplementation(
      ({
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
      })
    );
  });

  // ── Success paths ────────────────────────────────────────────────────────

  test('smoke: happy path returns a valid unsigned XDR transaction', async () => {
    const result = await makeService().buildDepositTransaction({
      userPublicKey: VALID_USER_KEY,
      vaultContractId: VALID_VAULT,
      amountUsdc: VALID_AMOUNT,
    });

    assert.equal(result.network, 'testnet');
    assert.equal(result.operation.type, 'invoke_contract');
    assert.equal(result.operation.function, 'deposit');
    assert.equal(result.operation.contractId, VALID_VAULT);
    assert.ok(result.xdr.startsWith('xdr:'), 'XDR should be present');
    assert.equal(result.memo, undefined);
  });

  test('smoke: uses injected createServer instead of real Horizon.Server', async () => {
    const fakeLoadAccount = jest.fn().mockResolvedValue({
      accountId: VALID_USER_KEY,
      sequence: '1',
    });
    const fakeServer = { loadAccount: fakeLoadAccount };
    const createServer = jest.fn().mockReturnValue(fakeServer);

    await makeService({ createServer }).buildDepositTransaction({
      userPublicKey: VALID_USER_KEY,
      vaultContractId: VALID_VAULT,
      amountUsdc: VALID_AMOUNT,
    });

    // Our injected server was used — not the real Horizon one
    assert.equal(createServer.mock.calls.length, 1);
    assert.equal(fakeLoadAccount.mock.calls.length, 1);
    assert.equal(mockServerConstructor.mock.calls.length, 0);
  });

  test('smoke: whitespace-only memo is treated as absent (no memo added)', async () => {
    const result = await makeService().buildDepositTransaction({
      userPublicKey: VALID_USER_KEY,
      vaultContractId: VALID_VAULT,
      amountUsdc: VALID_AMOUNT,
      memoText: '   ',
    });

    assert.equal(result.memo, undefined);
    assert.equal(mockAddMemo.mock.calls.length, 0);
  });

  test('smoke: null memo is treated as absent (no memo added)', async () => {
    const result = await makeService().buildDepositTransaction({
      userPublicKey: VALID_USER_KEY,
      vaultContractId: VALID_VAULT,
      amountUsdc: VALID_AMOUNT,
      memoText: null,
    });

    assert.equal(result.memo, undefined);
    assert.equal(mockAddMemo.mock.calls.length, 0);
  });

  test('smoke: amount with maximum allowed value builds successfully', async () => {
    const result = await makeService().buildDepositTransaction({
      userPublicKey: VALID_USER_KEY,
      vaultContractId: VALID_VAULT,
      amountUsdc: '1000000000.0000000', // exactly 1 billion USDC
    });

    assert.ok(result.xdr, 'should produce XDR for max amount');
    assert.equal(
      result.operation.args[1]?.value,
      '10000000000000000', // 1_000_000_000 * 10_000_000
      'stroops should match expected max value'
    );
  });

  // ── Input validation failures (must fail before loadAccount) ────────────

test('smoke: rejects mismatched vault contract ID with NetworkError before account load', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: VALID_USER_KEY,
        vaultContractId: 'BADCONTRACT',
        amountUsdc: VALID_AMOUNT,
      }),
      NetworkError
    );

    // Must fail before any network call is made
    assert.equal(mockLoadAccount.mock.calls.length, 0);
  });
  test('smoke: rejects bad user public key with InvalidStellarAddressError', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: 'BADKEY',
        vaultContractId: VALID_VAULT,
        amountUsdc: VALID_AMOUNT,
      }),
      InvalidStellarAddressError
    );

    assert.equal(mockLoadAccount.mock.calls.length, 0);
  });

  test('smoke: rejects zero-value amount with InvalidAmountError', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: VALID_USER_KEY,
        vaultContractId: VALID_VAULT,
        amountUsdc: '0.0000000',
      }),
      InvalidAmountError
    );

    assert.equal(mockLoadAccount.mock.calls.length, 0);
  });

  test('smoke: rejects amount missing decimal part with InvalidAmountError', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: VALID_USER_KEY,
        vaultContractId: VALID_VAULT,
        amountUsdc: '100',
      }),
      InvalidAmountError
    );
  });

  test('smoke: rejects amount with fewer than 7 decimal places with InvalidAmountError', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: VALID_USER_KEY,
        vaultContractId: VALID_VAULT,
        amountUsdc: '1.000',
      }),
      InvalidAmountError
    );
  });

  // ── Network / config mismatch failures ──────────────────────────────────

  test('smoke: rejects request network that differs from configured network', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: VALID_USER_KEY,
        vaultContractId: 'CVAULTMAIN',
        amountUsdc: VALID_AMOUNT,
        network: 'mainnet', // config is set to testnet
      }),
      NetworkError
    );

    assert.equal(mockLoadAccount.mock.calls.length, 0);
  });

  test('smoke: rejects vault contract ID that does not match configured ID', async () => {
    await assert.rejects(
      makeService().buildDepositTransaction({
        userPublicKey: VALID_USER_KEY,
        vaultContractId: 'CDIFFERENTVAULT',
        amountUsdc: VALID_AMOUNT,
      }),
      NetworkError
    );

    assert.equal(mockLoadAccount.mock.calls.length, 0);
  });
});