import {
  Keypair,
  TransactionBuilder,
  Networks,
  Account,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

// Mock config before importing feeBumper
jest.mock('../config/index.js', () => ({
  config: {
    stellar: {
      network: 'testnet',
      baseFee: '100',
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
  },
}));

jest.mock('../logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  calculateFeeQuote,
  createFeeBumpTransaction,
  FeeBumperConfigError,
  FeeBumperInvalidTransactionError,
  FeeBumperSigningError,
} from './feeBumper.js';

const TEST_NETWORK = Networks.TESTNET;

/** Build a minimal signed Stellar transaction XDR for use in tests */
function buildTestInnerXdr(keypair: Keypair, opCount = 1): string {
  const account = new Account(keypair.publicKey(), '100');
  let builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: TEST_NETWORK,
  }).setTimeout(30);

  for (let i = 0; i < opCount; i++) {
    builder = builder.addOperation(
      Operation.payment({
        destination: keypair.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    );
  }

  const tx = builder.build();
  tx.sign(keypair);
  return tx.toXDR();
}

describe('feeBumper service', () => {
  const innerKeypair = Keypair.random();
  const feeKeypair = Keypair.random();

  beforeEach(() => {
    delete process.env.FEE_BUMPER_SECRET_KEY;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.FEE_BUMPER_SECRET_KEY;
  });

  describe('calculateFeeQuote', () => {
    it('returns correct quote for a single-op transaction', () => {
      const xdr = buildTestInnerXdr(innerKeypair, 1);
      const quote = calculateFeeQuote(xdr);

      // base=100, multiplier=3, ops=1, outer_fee = 100 * 3 * (1+1) = 600
      expect(quote.baseFeeStroops).toBe(100);
      expect(quote.feeBumpFeeStroops).toBe(600);
      expect(quote.network).toBe('testnet');
      expect(Number(quote.feeBumpFeeXlm)).toBeCloseTo(600 / 10_000_000, 7);
      expect(Number(quote.appTokenAmount)).toBeGreaterThan(0);
    });

    it('scales fee with operation count', () => {
      const xdr1 = buildTestInnerXdr(innerKeypair, 1);
      const xdr2 = buildTestInnerXdr(innerKeypair, 2);

      const q1 = calculateFeeQuote(xdr1);
      const q2 = calculateFeeQuote(xdr2);

      // ops=2 → outer = 100 * 3 * 3 = 900 vs 100 * 3 * 2 = 600
      expect(q2.feeBumpFeeStroops).toBeGreaterThan(q1.feeBumpFeeStroops);
    });

    it('throws FeeBumperInvalidTransactionError for invalid XDR', () => {
      expect(() => calculateFeeQuote('not-valid-xdr')).toThrow(
        FeeBumperInvalidTransactionError,
      );
    });

    it('throws FeeBumperInvalidTransactionError for empty XDR', () => {
      expect(() => calculateFeeQuote('')).toThrow(FeeBumperInvalidTransactionError);
    });
  });

  describe('createFeeBumpTransaction', () => {
    it('throws FeeBumperConfigError when FEE_BUMPER_SECRET_KEY is not set', () => {
      const xdr = buildTestInnerXdr(innerKeypair);
      expect(() => createFeeBumpTransaction(xdr)).toThrow(FeeBumperConfigError);
      expect(() => createFeeBumpTransaction(xdr)).toThrow(
        'FEE_BUMPER_SECRET_KEY is not configured',
      );
    });

    it('throws FeeBumperConfigError when FEE_BUMPER_SECRET_KEY is invalid', () => {
      process.env.FEE_BUMPER_SECRET_KEY = 'INVALID_SECRET';
      const xdr = buildTestInnerXdr(innerKeypair);
      expect(() => createFeeBumpTransaction(xdr)).toThrow(FeeBumperConfigError);
    });

    it('returns signed fee-bump XDR when key is valid', () => {
      process.env.FEE_BUMPER_SECRET_KEY = feeKeypair.secret();
      const xdr = buildTestInnerXdr(innerKeypair);

      const result = createFeeBumpTransaction(xdr);

      expect(result.feeBumpXdr).toBeTruthy();
      expect(typeof result.feeBumpXdr).toBe('string');
      expect(result.feeAccountPublicKey).toBe(feeKeypair.publicKey());
      expect(result.feeStroops).toBeGreaterThan(0);
    });

    it('fee account public key matches the configured secret key', () => {
      process.env.FEE_BUMPER_SECRET_KEY = feeKeypair.secret();
      const xdr = buildTestInnerXdr(innerKeypair);

      const result = createFeeBumpTransaction(xdr);

      expect(result.feeAccountPublicKey).toBe(feeKeypair.publicKey());
    });

    it('throws FeeBumperInvalidTransactionError for invalid inner XDR', () => {
      process.env.FEE_BUMPER_SECRET_KEY = feeKeypair.secret();
      expect(() => createFeeBumpTransaction('garbage-xdr')).toThrow(
        FeeBumperInvalidTransactionError,
      );
    });

    it('logs info messages during successful creation', () => {
      const { logger } = require('../logger.js') as { logger: { info: jest.Mock } };
      process.env.FEE_BUMPER_SECRET_KEY = feeKeypair.secret();
      const xdr = buildTestInnerXdr(innerKeypair);

      createFeeBumpTransaction(xdr);

      expect(logger.info).toHaveBeenCalledWith(
        'Creating fee-bump transaction',
        expect.objectContaining({ feeAccount: feeKeypair.publicKey() }),
      );
    });
  });
});
