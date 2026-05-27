import assert from 'node:assert';
import * as fc from 'fast-check';
import { AmountValidator } from './amountValidator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STROOPS_PER_USDC = BigInt(10 ** AmountValidator.USDC_DECIMALS);
const MAX_STROOPS = BigInt(AmountValidator.MAX_AMOUNT) * STROOPS_PER_USDC;

/**
 * Convert a stroop count back to a canonical 7-decimal string.
 * This is the inverse of toSmallestUnit and is guaranteed to produce
 * an exactly-representable IEEE 754 double (since we derive the string
 * from integer arithmetic, not from floating-point).
 */
function stroopsToCanonical(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = stroops % STROOPS_PER_USDC;
  return `${whole}.${String(frac).padStart(7, '0')}`;
}

/**
 * Arbitrary for valid canonical USDC amounts.
 * Generated from stroop integers so the resulting string is always
 * exactly representable as a float64 (no precision-loss rejections).
 */
const validStroopsArb = fc.bigInt({ min: 1n, max: MAX_STROOPS });
const validAmountArb = validStroopsArb.map(stroopsToCanonical);

// ---------------------------------------------------------------------------
// Unit tests – valid inputs
// ---------------------------------------------------------------------------

describe('AmountValidator.validateUsdcAmount – valid inputs', () => {
  it('accepts a typical amount', () => {
    const r = AmountValidator.validateUsdcAmount('100.0000000');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.normalizedAmount, '100.0000000');
  });

  it('accepts the smallest non-zero step (1 stroop)', () => {
    const r = AmountValidator.validateUsdcAmount('0.0000001');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.normalizedAmount, '0.0000001');
  });

  it('accepts the maximum allowed amount', () => {
    const r = AmountValidator.validateUsdcAmount('1000000000.0000000');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.normalizedAmount, '1000000000.0000000');
  });
});

// ---------------------------------------------------------------------------
// Unit tests – invalid inputs
// ---------------------------------------------------------------------------

describe('AmountValidator.validateUsdcAmount – invalid inputs', () => {
  // --- type guard ---
  it('rejects non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(AmountValidator.validateUsdcAmount(100 as any).valid, false);
  });

  // --- zero / negative ---
  it('rejects zero', () => {
    const r = AmountValidator.validateUsdcAmount('0.0000000');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'Amount must be greater than zero');
  });

  it('rejects negative amount', () => {
    assert.strictEqual(AmountValidator.validateUsdcAmount('-1.0000000').valid, false);
  });

  // --- precision ---
  it('rejects too few decimal places', () => {
    assert.strictEqual(AmountValidator.validateUsdcAmount('100.00').valid, false);
  });

  it('rejects too many decimal places (8)', () => {
    assert.strictEqual(AmountValidator.validateUsdcAmount('100.00000001').valid, false);
  });

  it('rejects no decimal point', () => {
    assert.strictEqual(AmountValidator.validateUsdcAmount('100').valid, false);
  });

  // --- scientific notation ---
  it('rejects scientific notation variants', () => {
    for (const v of ['1e7', '1E7', '1e+7', '1e-7', '5.0e3', '1.0E+7', '1.23e5']) {
      assert.strictEqual(
        AmountValidator.validateUsdcAmount(v).valid,
        false,
        `expected invalid for "${v}"`
      );
    }
  });

  // --- NaN / Infinity strings ---
  it('rejects NaN and Infinity strings', () => {
    for (const v of ['NaN', 'Infinity', '-Infinity', 'inf']) {
      assert.strictEqual(
        AmountValidator.validateUsdcAmount(v).valid,
        false,
        `expected invalid for "${v}"`
      );
    }
  });

  // --- locale / whitespace / special chars ---
  it('rejects locale-formatted and whitespace-padded strings', () => {
    for (const v of [
      '1,000.0000000',
      '1000,0000000',
      '1.000,0000000',
      '1000.0000000 ',
      ' 1000.0000000',
      '1_000.0000000',
    ]) {
      assert.strictEqual(
        AmountValidator.validateUsdcAmount(v).valid,
        false,
        `expected invalid for "${v}"`
      );
    }
  });

  it('rejects empty string', () => {
    assert.strictEqual(AmountValidator.validateUsdcAmount('').valid, false);
  });

  it('rejects alphabetic input', () => {
    assert.strictEqual(AmountValidator.validateUsdcAmount('abc.0000000').valid, false);
  });

  // --- over maximum ---
  it('rejects amount exceeding 1 billion USDC', () => {
    const r = AmountValidator.validateUsdcAmount('1000000001.0000000');
    assert.strictEqual(r.valid, false);
    assert.match(r.error!, /maximum/i);
  });
});

// ---------------------------------------------------------------------------
// toSmallestUnit – bigint round-trip
// ---------------------------------------------------------------------------

describe('AmountValidator.toSmallestUnit', () => {
  it('converts 1.0000000 to 10_000_000n', () => {
    assert.strictEqual(AmountValidator.toSmallestUnit('1.0000000'), 10_000_000n);
  });

  it('converts 0.0000001 to 1n (1 stroop)', () => {
    assert.strictEqual(AmountValidator.toSmallestUnit('0.0000001'), 1n);
  });

  it('converts 100.0000000 to 1_000_000_000n', () => {
    assert.strictEqual(AmountValidator.toSmallestUnit('100.0000000'), 1_000_000_000n);
  });

  it('throws on invalid input', () => {
    assert.throws(() => AmountValidator.toSmallestUnit('1e7'), /Invalid amount/);
  });

  it('result is always a non-negative bigint', () => {
    const stroops = AmountValidator.toSmallestUnit('0.0000001');
    assert.strictEqual(typeof stroops, 'bigint');
    assert.ok(stroops >= 0n);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (fast-check)
// ---------------------------------------------------------------------------

describe('AmountValidator – property tests', () => {
  it('all valid canonical amounts are accepted', () => {
    fc.assert(
      fc.property(validAmountArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === true;
      }),
      { numRuns: 500 }
    );
  });

  it('normalizedAmount always equals the input for valid amounts', () => {
    fc.assert(
      fc.property(validAmountArb, (amount) => {
        const r = AmountValidator.validateUsdcAmount(amount);
        return r.normalizedAmount === amount;
      }),
      { numRuns: 500 }
    );
  });

  it('toSmallestUnit round-trips: stroop → canonical string → stroop', () => {
    fc.assert(
      fc.property(validStroopsArb, (stroops) => {
        const amount = stroopsToCanonical(stroops);
        return AmountValidator.toSmallestUnit(amount) === stroops;
      }),
      { numRuns: 500 }
    );
  });

  it('toSmallestUnit result is always a non-negative bigint', () => {
    fc.assert(
      fc.property(validAmountArb, (amount) => {
        const stroops = AmountValidator.toSmallestUnit(amount);
        return typeof stroops === 'bigint' && stroops >= 0n;
      }),
      { numRuns: 500 }
    );
  });

  it('scientific-notation strings are always rejected', () => {
    // Build strings like "123e5", "4.5E+3" from integer mantissa + exponent.
    const sciArb = fc
      .tuple(
        fc.integer({ min: 1, max: 999_999 }),
        fc.integer({ min: 1, max: 9 }),
        fc.constantFrom('e', 'E'),
        fc.constantFrom('', '+', '-')
      )
      .map(([mantissa, exp, e, sign]) => `${mantissa}${e}${sign}${exp}`);

    fc.assert(
      fc.property(sciArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 300 }
    );
  });

  it('strings with more than 7 decimal places are always rejected', () => {
    // 8-digit fractional part: pad an integer to 8 digits.
    const overPrecisionArb = fc
      .tuple(
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 99_999_999 })
      )
      .map(([whole, frac]) => `${whole}.${String(frac).padStart(8, '0')}`);

    fc.assert(
      fc.property(overPrecisionArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 300 }
    );
  });

  it('whitespace-padded strings are always rejected', () => {
    const paddedArb = fc
      .tuple(validAmountArb, fc.constantFrom(' ', '\t', '\n'), fc.boolean())
      .map(([amount, ws, prepend]) => (prepend ? `${ws}${amount}` : `${amount}${ws}`));

    fc.assert(
      fc.property(paddedArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 200 }
    );
  });
});
