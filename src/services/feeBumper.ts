import {
  Keypair,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
  Networks,
} from '@stellar/stellar-sdk';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

// Stroops per XLM
const STROOPS_PER_XLM = 10_000_000n;
// Approximate exchange rate: 1 XLM = 0.10 USDC (used for quote only)
const XLM_TO_APP_TOKEN_RATE = 0.10;
// Fee multiplier applied on top of the base fee for fee-bump outer fee
const FEE_BUMP_MULTIPLIER = 3;

export class FeeBumperConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeBumperConfigError';
  }
}

export class FeeBumperSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeBumperSigningError';
  }
}

export class FeeBumperInvalidTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeBumperInvalidTransactionError';
  }
}

export interface FeeQuote {
  baseFeeStroops: number;
  feeBumpFeeStroops: number;
  feeBumpFeeXlm: string;
  appTokenAmount: string;
  network: string;
}

export interface FeeBumpResult {
  feeBumpXdr: string;
  feeAccountPublicKey: string;
  feeStroops: number;
}

function getNetworkPassphrase(): string {
  return config.stellar.network === 'mainnet'
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

function getFeeKeypair(): Keypair {
  const secretKey = process.env.FEE_BUMPER_SECRET_KEY;
  if (!secretKey) {
    throw new FeeBumperConfigError('FEE_BUMPER_SECRET_KEY is not configured');
  }
  try {
    return Keypair.fromSecret(secretKey);
  } catch {
    throw new FeeBumperConfigError('FEE_BUMPER_SECRET_KEY is not a valid Stellar secret key');
  }
}

/**
 * Calculate a fee-bump quote for a given inner transaction XDR.
 * The outer fee is FEE_BUMP_MULTIPLIER × base_fee × (inner_ops + 1).
 */
export function calculateFeeQuote(innerXdr: string): FeeQuote {
  let innerTx: Transaction;
  const passphrase = getNetworkPassphrase();
  try {
    innerTx = new Transaction(innerXdr, passphrase);
  } catch {
    throw new FeeBumperInvalidTransactionError('innerXdr is not a valid Stellar transaction XDR');
  }

  const opCount = innerTx.operations.length;
  const baseFeeStroops = Number(config.stellar.baseFee);
  // fee-bump outer fee: multiplier × base_fee × (inner_ops + 1)
  const feeBumpFeeStroops = baseFeeStroops * FEE_BUMP_MULTIPLIER * (opCount + 1);
  const feeBumpFeeXlm = (feeBumpFeeStroops / Number(STROOPS_PER_XLM)).toFixed(7);
  const appTokenAmount = (feeBumpFeeStroops / Number(STROOPS_PER_XLM) * XLM_TO_APP_TOKEN_RATE).toFixed(7);

  return {
    baseFeeStroops,
    feeBumpFeeStroops,
    feeBumpFeeXlm,
    appTokenAmount,
    network: config.stellar.network,
  };
}

/**
 * Create and sign a fee-bump transaction wrapping the supplied inner XDR.
 * The fee account (KMS-backed env var key) pays all fees.
 */
export function createFeeBumpTransaction(innerXdr: string): FeeBumpResult {
  const passphrase = getNetworkPassphrase();
  let innerTx: Transaction;
  try {
    innerTx = new Transaction(innerXdr, passphrase);
  } catch {
    throw new FeeBumperInvalidTransactionError('innerXdr is not a valid Stellar transaction XDR');
  }

  const quote = calculateFeeQuote(innerXdr);
  const feeKeypair = getFeeKeypair();

  logger.info('Creating fee-bump transaction', {
    feeAccount: feeKeypair.publicKey(),
    feeStroops: quote.feeBumpFeeStroops,
    network: config.stellar.network,
  });

  let feeBumpTx: FeeBumpTransaction;
  try {
    feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeKeypair,
      String(quote.feeBumpFeeStroops),
      innerTx,
      passphrase,
    );
  } catch (err) {
    logger.error('Failed to build fee-bump transaction', err);
    throw new FeeBumperSigningError(
      `Failed to build fee-bump transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    feeBumpTx.sign(feeKeypair);
  } catch (err) {
    logger.error('Failed to sign fee-bump transaction', err);
    throw new FeeBumperSigningError(
      `Failed to sign fee-bump transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    feeBumpXdr: feeBumpTx.toXDR(),
    feeAccountPublicKey: feeKeypair.publicKey(),
    feeStroops: quote.feeBumpFeeStroops,
  };
}
