import {
  Keypair,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
  Networks,
  Operation,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

// Stroops per XLM
const STROOPS_PER_XLM = 10_000_000n;
// Fee multiplier applied on top of the base fee for fee-bump outer fee
const FEE_BUMP_MULTIPLIER = 3n;

/**
 * Integer-scaled app-token rate. The rate is expressed as
 * `numerator / denominator` app-token units per stroop, avoiding floats.
 * Configurable via FEE_ABSTRACTION_RATE_NUMERATOR / FEE_ABSTRACTION_RATE_DENOMINATOR.
 */
function getRate(): { numerator: bigint; denominator: bigint } {
  const numRaw = process.env.FEE_ABSTRACTION_RATE_NUMERATOR;
  const denRaw = process.env.FEE_ABSTRACTION_RATE_DENOMINATOR;
  const numerator = numRaw ? BigInt(numRaw) : 1n;
  const denominator = denRaw ? BigInt(denRaw) : 10n;
  if (numerator <= 0n || denominator <= 0n) {
    throw new FeeBumperConfigError('FEE_ABSTRACTION_RATE_* must be positive integers');
  }
  return { numerator, denominator };
}

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
  baseFeeStroops: bigint;
  feeBumpFeeStroops: bigint;
  /** Per-op outer fee rate; the envelope charges rate × (inner_ops + 1) + inner resource fee. */
  outerPerOpFeeStroops: bigint;
  feeBumpFeeXlm: string;
  appTokenAmount: string;
  network: string;
}

export interface FeeBumpResult {
  feeBumpXdr: string;
  feeAccountPublicKey: string;
  feeStroops: bigint;
}

export interface FeeBumpPolicy {
  /** Stellar address the inner transaction source must match. */
  expectedSource?: string;
  /** Set of vault contract ids allowed as invokeHostFunction targets. */
  allowedVaultContractIds?: string[];
  /** Expected inner transaction hash (hex). */
  expectedInnerHash?: string;
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

function parseInnerTransaction(innerXdr: string): Transaction {
  const passphrase = getNetworkPassphrase();
  try {
    return new Transaction(innerXdr, passphrase);
  } catch {
    throw new FeeBumperInvalidTransactionError('innerXdr is not a valid Stellar transaction XDR');
  }
}

/**
 * Soroban resource fee declared by the inner envelope (0 for classic). Read via
 * the public XDR envelope: `Transaction` exposes no `sorobanData` accessor.
 */
function getInnerResourceFee(innerTx: Transaction): bigint {
  const envelope = innerTx.toEnvelope();
  if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) {
    return 0n;
  }
  const sorobanData = envelope.v1().tx().ext().value();
  return sorobanData ? sorobanData.resourceFee().toBigInt() : 0n;
}

/**
 * Per-operation outer fee rate. The configured multiplier is the policy floor; it is raised
 * to the SDK's own minimums (inner per-op inclusion rate rounded up, and BASE_FEE) so that
 * buildFeeBumpTransaction never rejects a valid inner transaction.
 */
function getOuterPerOpFee(innerTx: Transaction): bigint {
  const opCount = BigInt(innerTx.operations.length);
  if (opCount === 0n) {
    throw new FeeBumperInvalidTransactionError('inner transaction has no operations');
  }
  const innerFee = BigInt(innerTx.fee);
  const resourceFee = getInnerResourceFee(innerTx);
  if (innerFee < resourceFee) {
    throw new FeeBumperInvalidTransactionError('inner fee is below its Soroban resource fee');
  }
  // ceil((fee - resourceFee) / ops): the SDK requires base >= this rational value.
  const innerInclusionRate = (innerFee - resourceFee + opCount - 1n) / opCount;
  const sdkBaseFee = BigInt(BASE_FEE);
  const sdkMinimum = sdkBaseFee > innerInclusionRate ? sdkBaseFee : innerInclusionRate;
  const policyFloor = BigInt(config.stellar.baseFee) * FEE_BUMP_MULTIPLIER;
  return policyFloor > sdkMinimum ? policyFloor : sdkMinimum;
}

/**
 * Calculate a fee-bump quote for a given inner transaction XDR.
 * The outer fee is `inner resource fee + outer_per_op_fee × (inner_ops + 1)`,
 * computed entirely in bigint stroops.
 */
export function calculateFeeQuote(innerXdr: string): FeeQuote {
  const innerTx = parseInnerTransaction(innerXdr);

  const opCount = BigInt(innerTx.operations.length);
  const baseFeeStroops = BigInt(config.stellar.baseFee);
  const resourceFee = getInnerResourceFee(innerTx);
  const outerPerOpFeeStroops = getOuterPerOpFee(innerTx);
  // fee-bump outer fee: resource fee + per-op outer fee × (inner_ops + 1)
  const feeBumpFeeStroops = resourceFee + outerPerOpFeeStroops * (opCount + 1n);
  const feeBumpFeeXlm = formatStroops(feeBumpFeeStroops);
  const { numerator, denominator } = getRate();
  const appTokenUnits = (feeBumpFeeStroops * numerator + denominator - 1n) / denominator;

  return {
    baseFeeStroops,
    feeBumpFeeStroops,
    outerPerOpFeeStroops,
    feeBumpFeeXlm,
    appTokenAmount: appTokenUnits.toString(),
    network: config.stellar.network,
  };
}

/** Format a bigint stroop amount as a 7-decimal XLM string without floats. */
function formatStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

/**
 * Enforce the inner-transaction policy before signing.
 * Throws `FeeBumperInvalidTransactionError` on any violation.
 */
export function assertInnerTransactionPolicy(
  innerXdr: string,
  policy: FeeBumpPolicy,
): Transaction {
  const innerTx = parseInnerTransaction(innerXdr);

  if (policy.expectedInnerHash) {
    const actualHash = innerTx.hash().toString('hex');
    if (actualHash !== policy.expectedInnerHash) {
      throw new FeeBumperInvalidTransactionError('innerXdr hash does not match the quoted hash');
    }
  }

  if (policy.expectedSource) {
    const source = innerTx.source;
    if (source !== policy.expectedSource) {
      throw new FeeBumperInvalidTransactionError('inner transaction source is not the authenticated user');
    }
  }

  if (policy.allowedVaultContractIds) {
    const allowed = new Set(policy.allowedVaultContractIds);
    for (const op of innerTx.operations) {
      if (op.type !== 'invokeHostFunction') {
        throw new FeeBumperInvalidTransactionError(
          `operation type ${op.type} is not allowed for fee-abstraction`,
        );
      }
      const invokeOp = op as Operation.InvokeHostFunction;
      const contractId = extractContractId(invokeOp);
      if (!contractId || !allowed.has(contractId)) {
        throw new FeeBumperInvalidTransactionError(
          'invokeHostFunction targets a contract outside the allowlist',
        );
      }
    }
  }

  return innerTx;
}

/** Extract the targeted contract id from an invokeHostFunction operation. */
function extractContractId(op: Operation.InvokeHostFunction): string | undefined {
  const func = op.func;
  if (!func) {
    return undefined;
  }
  const asNx = func as unknown as { contractId?: () => { toString: () => string } };
  if (typeof asNx.contractId === 'function') {
    try {
      return asNx.contractId().toString();
    } catch {
      return undefined;
    }
  }
  const asInvoke = func as unknown as {
    invokeContract?: () => { contractAddress?: () => { toString: () => string } };
  };
  if (typeof asInvoke.invokeContract === 'function') {
    try {
      const addr = asInvoke.invokeContract().contractAddress?.();
      return addr ? addr.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Create and sign a fee-bump transaction wrapping the supplied inner XDR.
 * The fee account (KMS-backed env var key) pays all fees.
 */
export function createFeeBumpTransaction(innerXdr: string): FeeBumpResult {
  const passphrase = getNetworkPassphrase();
  const innerTx = parseInnerTransaction(innerXdr);

  const quote = calculateFeeQuote(innerXdr);
  const feeKeypair = getFeeKeypair();

  logger.info('Creating fee-bump transaction', {
    feeAccount: feeKeypair.publicKey(),
    feeStroops: quote.feeBumpFeeStroops.toString(),
    network: config.stellar.network,
  });

  // SDK charges per-op rate × (inner_ops + 1) + inner resource fee, so pass the per-op rate.
  let feeBumpTx: FeeBumpTransaction;
  try {
    feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeKeypair,
      quote.outerPerOpFeeStroops.toString(),
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
    feeStroops: BigInt(feeBumpTx.fee),
  };
}
