import { logger, getRequestId } from '../logger.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  code?: string;
  normalizedAmount?: string;
}

export class AmountValidator {
  static readonly USDC_DECIMALS = 7;
  static readonly MAX_AMOUNT = 1_000_000_000;

  /**
   * Strict format: one or more digits, a literal dot, exactly 7 decimal digits.
   * Rejects scientific notation, leading signs, whitespace, and locale separators.
   */
  private static readonly AMOUNT_PATTERN = /^\d+\.\d{7}$/;

  /** Maximum value in stroops (1 USDC = 10^7 stroops). */
  private static readonly MAX_STROOPS =
    BigInt(AmountValidator.MAX_AMOUNT) * BigInt(10 ** AmountValidator.USDC_DECIMALS);

  /**
   * Validates a USDC amount string and normalizes it.
   * Implements boundary validation and returns a standardized error envelope on failure.
   * Logs validation failures with correlation IDs for tracing.
   *
   * @param amount The USDC amount string to validate
   * @returns ValidationResult with standard error code or normalized amount
   */
  static validateUsdcAmount(amount: string): ValidationResult {
    const correlationId = getRequestId() ?? 'unknown';

    if (typeof amount !== 'string') {
      logger.warn('[AmountValidator] Validation failed: Amount must be a string', { correlationId, amountType: typeof amount });
      return { valid: false, error: 'Amount must be a string', code: 'INVALID_AMOUNT_TYPE' };
    }

    // Reject scientific notation and any non-canonical form before parsing.
    if (!this.AMOUNT_PATTERN.test(amount)) {
      logger.warn('[AmountValidator] Validation failed: Invalid amount format', { correlationId, provided: amount });
      return {
        valid: false,
        error: 'Amount must have exactly 7 decimal places (e.g., "100.0000000")',
        code: 'INVALID_AMOUNT_FORMAT'
      };
    }

    // Parse using bigint arithmetic to avoid IEEE 754 precision loss.
    const [whole, frac] = amount.split('.');
    const stroops = BigInt(whole) * BigInt(10 ** this.USDC_DECIMALS) + BigInt(frac);

    if (stroops <= 0n) {
      logger.warn('[AmountValidator] Validation failed: Amount is zero or negative', { correlationId, provided: amount });
      return { valid: false, error: 'Amount must be greater than zero', code: 'INVALID_AMOUNT_RANGE' };
    }

    if (stroops > this.MAX_STROOPS) {
      logger.warn('[AmountValidator] Validation failed: Amount exceeds maximum', { correlationId, provided: amount });
      return {
        valid: false,
        error: 'Amount exceeds maximum limit of 1,000,000,000 USDC',
        code: 'AMOUNT_EXCEEDS_MAXIMUM'
      };
    }

    // Reconstruct the canonical string from bigint to guarantee exact representation.
    const normalizedAmount = `${whole}.${frac}`;

    return { valid: true, normalizedAmount };
  }

  /**
   * Convert a validated USDC string (7 decimal places) to its smallest-unit
   * bigint representation (stroops: 1 USDC = 10_000_000 stroops).
   * Throws if the input is not a valid, canonical 7-decimal string.
   */
  static toSmallestUnit(amount: string): bigint {
    const result = this.validateUsdcAmount(amount);
    if (!result.valid || !result.normalizedAmount) {
      const correlationId = getRequestId() ?? 'unknown';
      logger.error('[AmountValidator] Fatal validation error during conversion', { correlationId, error: result.error, code: result.code });
      throw new Error(`Invalid amount: ${result.error}`);
    }
    const [whole, frac] = result.normalizedAmount.split('.');
    return BigInt(whole) * BigInt(10 ** this.USDC_DECIMALS) + BigInt(frac);
  }
}
