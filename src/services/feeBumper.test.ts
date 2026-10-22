import {
  Keypair,
  TransactionBuilder,
  Networks,
  Account,
  Operation,
  Asset,
  xdr,
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
} from './feeBumper.js';

const TEST_NETWORK = Networks.TESTNET;

/** Build a minimal signed Stellar transaction XDR for use in tests */
function buildTestInnerXdr(keypair: Keypair, opCount = 1, fee = '100'): string {
  const account = new Account(keypair.publicKey(), '100');
  let builder = new TransactionBuilder(account, {
    fee,
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
      expect(quote.baseFeeStroops).toBe(100n);
      expect(quote.feeBumpFeeStroops).toBe(600n);
      expect(quote.network).toBe('testnet');
      expect(Number(quote.feeBumpFeeXlm)).toBeCloseTo(600 / 10_000_000, 7);
      expect(Number(quote.appTokenAmount)).toBeGreaterThan(0);
    });

    it.each([[7, 86n], [1000, 1n]])('rounds fractional app-token units up at denominator %s', (denominator, expected) => {
      const originalNumerator = process.env.FEE_ABSTRACTION_RATE_NUMERATOR;
      const originalDenominator = process.env.FEE_ABSTRACTION_RATE_DENOMINATOR;
      process.env.FEE_ABSTRACTION_RATE_NUMERATOR = '1';
      process.env.FEE_ABSTRACTION_RATE_DENOMINATOR = String(denominator);
      try {
        const quote = calculateFeeQuote(buildTestInnerXdr(innerKeypair));
        expect(BigInt(quote.appTokenAmount)).toBe(expected);
      } finally {
        if (originalNumerator === undefined) delete process.env.FEE_ABSTRACTION_RATE_NUMERATOR;
        else process.env.FEE_ABSTRACTION_RATE_NUMERATOR = originalNumerator;
        if (originalDenominator === undefined) delete process.env.FEE_ABSTRACTION_RATE_DENOMINATOR;
        else process.env.FEE_ABSTRACTION_RATE_DENOMINATOR = originalDenominator;
      }
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

    it('includes the Soroban resource fee declared by the inner transaction', () => {
      const sorobanData = new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(0),
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
          instructions: 0,
          diskReadBytes: 0,
          writeBytes: 0,
        }),
        resourceFee: xdr.Int64.fromString('5000'),
      });
      const account = new Account(innerKeypair.publicKey(), '100');
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: TEST_NETWORK,
        sorobanData,
      })
        .addOperation(
          Operation.payment({ destination: innerKeypair.publicKey(), asset: Asset.native(), amount: '1' }),
        )
        .setTimeout(30)
        .build();
      tx.sign(innerKeypair);

      // outer = resource 5000 + base 100 × 3 × (1 + 1) = 5600
      expect(calculateFeeQuote(tx.toXDR()).feeBumpFeeStroops).toBe(5600n);
    });
  });

  describe('createFeeBumpTransaction', () => {
    it('throws FeeBumperConfigError when FEE_BUMPER_SECRET_KEY is not set', () => {
      const xdr = buildTestInnerXdr(innerKeypair);
      expect(() => createFeeBumpTransaction(xdr)).toThrow(FeeBumperConfigError);
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
      expect(result.feeStroops).toBeGreaterThan(0n);
    });

    it('charges the outer fee quoted by calculateFeeQuote', () => {
      process.env.FEE_BUMPER_SECRET_KEY = feeKeypair.secret();
      const xdr = buildTestInnerXdr(innerKeypair, 2);

      const result = createFeeBumpTransaction(xdr);
      const envelope = TransactionBuilder.fromXDR(result.feeBumpXdr, TEST_NETWORK);

      expect(BigInt(envelope.fee)).toBe(calculateFeeQuote(xdr).feeBumpFeeStroops);
    });

    it('prices above the configured multiplier when the inner fee is higher', () => {
      process.env.FEE_BUMPER_SECRET_KEY = feeKeypair.secret();
      // inner per-op fee 1000 > 3 × base (300): the SDK minimum must win and quote must match the envelope
      const xdr = buildTestInnerXdr(innerKeypair, 1, '1000');

      const quote = calculateFeeQuote(xdr);
      const result = createFeeBumpTransaction(xdr);

      expect(quote.outerPerOpFeeStroops).toBe(1000n);
      expect(quote.feeBumpFeeStroops).toBe(2000n);
      expect(result.feeStroops).toBe(2000n);
      expect(BigInt(TransactionBuilder.fromXDR(result.feeBumpXdr, TEST_NETWORK).fee)).toBe(2000n);
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

  });
});
