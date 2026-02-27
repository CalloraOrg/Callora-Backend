import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AmountValidator } from './amountValidator.js';

describe('AmountValidator', () => {
  describe('validateUsdcAmount', () => {
    it('should accept valid amount with 7 decimals', () => {
      const result = AmountValidator.validateUsdcAmount('100.0000000');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.normalizedAmount, '100.0000000');
      assert.strictEqual(result.error, undefined);
    });

    it('should accept small valid amount', () => {
      const result = AmountValidator.validateUsdcAmount('0.0000001');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.normalizedAmount, '0.0000001');
    });

    it('should accept maximum valid amount', () => {
      const result = AmountValidator.validateUsdcAmount('1000000000.0000000');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.normalizedAmount, '1000000000.0000000');
    });

    it('should reject amount with wrong decimal places (too few)', () => {
      const result = AmountValidator.validateUsdcAmount('100.00');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(
        result.error,
        'Amount must have exactly 7 decimal places (e.g., "100.0000000")'
      );
    });

    it('should reject amount with wrong decimal places (too many)', () => {
      const result = AmountValidator.validateUsdcAmount('100.00000000');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(
        result.error,
        'Amount must have exactly 7 decimal places (e.g., "100.0000000")'
      );
    });

    it('should reject amount without decimal point', () => {
      const result = AmountValidator.validateUsdcAmount('100');
      assert.strictEqual(result.valid, false);
    });

    it('should reject zero amount', () => {
      const result = AmountValidator.validateUsdcAmount('0.0000000');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Amount must be greater than zero');
    });

    it('should reject negative amount', () => {
      const result = AmountValidator.validateUsdcAmount('-50.0000000');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Amount must have exactly 7 decimal places (e.g., "100.0000000")');
    });

    it('should reject amount exceeding maximum', () => {
      const result = AmountValidator.validateUsdcAmount('1000000001.0000000');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(
        result.error,
        'Amount exceeds maximum limit of 1,000,000,000 USDC'
      );
    });

    it('should reject non-string input', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = AmountValidator.validateUsdcAmount(100 as any);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, 'Amount must be a string');
    });

    it('should reject invalid format (letters)', () => {
      const result = AmountValidator.validateUsdcAmount('abc.0000000');
      assert.strictEqual(result.valid, false);
    });

    it('should reject empty string', () => {
      const result = AmountValidator.validateUsdcAmount('');
      assert.strictEqual(result.valid, false);
    });

    it('should reject scientific notation', () => {
      const result = AmountValidator.validateUsdcAmount('1e7');
      assert.strictEqual(result.valid, false);
    });
  });
});
