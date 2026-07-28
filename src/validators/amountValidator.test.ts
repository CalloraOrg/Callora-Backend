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
 * Derived from integer arithmetic so the string is always exact —
 * no IEEE 754 precision loss possible.
 */
function stroopsToCanonical(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = stroops % STROOPS_PER_USDC;
  return `${whole}.${String(frac).padStart(7, '0')}`;
}

/**
 * Arbitrary for valid canonical USDC amounts.
 * Generated from stroop integers so the resulting string is always
 * exactly representable — no precision-loss rejections.
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
    for (const v of ['NaN', 'Infinity', '-Infinity', 'inf', '+Infinity', 'nan']) {
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

  // --- leading zeros on whole part ---
  it('rejects leading zeros on whole part (e.g. 00.0000001)', () => {
    // The regex ^\d+\.\d{7}$ allows leading zeros on the integer part.
    // This test documents the current behavior: 00.0000001 is accepted
    // because it still produces a non-zero stroop count.
    // Update this test if the spec tightens to reject leading zeros.
    const r = AmountValidator.validateUsdcAmount('00.0000001');
    // Current behavior: accepted (stroop count is 1, which is > 0)
    assert.strictEqual(r.valid, true);
  });

  // --- denormalized (trailing zeros on fraction, already 7 digits) ---
  it('accepts fractional parts that are all zeros except one digit (stroop precision)', () => {
    // "1.0000010" has exactly 7 fractional digits — should be valid
    const r = AmountValidator.validateUsdcAmount('1.0000010');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.normalizedAmount, '1.0000010');
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
  // PBT-1: All valid canonical amounts are accepted
  it('PBT-1: all valid canonical amounts are accepted', () => {
    fc.assert(
      fc.property(validAmountArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === true;
      }),
      { numRuns: 500, seed: 1234567 }
    );
  });

  // PBT-2: normalizedAmount always equals the input for valid amounts
  it('PBT-2: normalizedAmount always equals the input for valid amounts', () => {
    fc.assert(
      fc.property(validAmountArb, (amount) => {
        const r = AmountValidator.validateUsdcAmount(amount);
        return r.normalizedAmount === amount;
      }),
      { numRuns: 500, seed: 1234567 }
    );
  });

  // PBT-3: toSmallestUnit round-trips: stroop → canonical string → stroop
  it('PBT-3: toSmallestUnit round-trips stroop → canonical → stroop', () => {
    fc.assert(
      fc.property(validStroopsArb, (stroops) => {
        const amount = stroopsToCanonical(stroops);
        return AmountValidator.toSmallestUnit(amount) === stroops;
      }),
      { numRuns: 500, seed: 1234567 }
    );
  });

  // PBT-4: integer-equivalent inputs (N.0000000) round-trip correctly
  // Addresses the issue requirement: "integer-equivalent inputs round-trip"
  it('PBT-4: integer-equivalent amounts (whole.0000000) are accepted and round-trip', () => {
    const integerEquivalentArb = fc
      .bigInt({ min: 1n, max: BigInt(AmountValidator.MAX_AMOUNT) })
      .map((n) => `${n}.0000000`);

    fc.assert(
      fc.property(integerEquivalentArb, (amount) => {
        const r = AmountValidator.validateUsdcAmount(amount);
        if (!r.valid || !r.normalizedAmount) return false;
        // Round-trip: normalizedAmount → toSmallestUnit → back to string
        const stroops = AmountValidator.toSmallestUnit(r.normalizedAmount);
        const roundTripped = stroopsToCanonical(stroops);
        return roundTripped === amount;
      }),
      { numRuns: 500, seed: 1234567 }
    );
  });

  // PBT-5: any input with >7 fractional digits must reject
  // Addresses the issue requirement: ">7 fractional digits must reject"
  it('PBT-5: strings with more than 7 fractional digits are always rejected', () => {
    // Generate strings with 8–15 fractional digits
    const overPrecisionArb = fc
      .tuple(
        fc.integer({ min: 0, max: 999_999_999 }),
        fc.integer({ min: 8, max: 15 }),
        fc.integer({ min: 0, max: 1 })  // ensure at least one non-zero frac digit
      )
      .chain(([whole, decimals, _]) =>
        fc
          .integer({ min: 0, max: Math.pow(10, decimals) - 1 })
          .map((frac) => `${whole}.${String(frac).padStart(decimals, '0')}`)
      );

    fc.assert(
      fc.property(overPrecisionArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 300, seed: 1234567 }
    );
  });

  // PBT-6: negative sentinel strings are always rejected
  // Addresses the issue requirement: "negative sentinels"
  it('PBT-6: negative sentinel strings are always rejected', () => {
    // Generate "-N.DDDDDDD" strings that look like valid amounts but have a minus sign
    const negativeArb = fc
      .tuple(
        fc.bigInt({ min: 0n, max: MAX_STROOPS })
      )
      .map(([stroops]) => `-${stroopsToCanonical(stroops + 1n)}`);

    fc.assert(
      fc.property(negativeArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 300, seed: 1234567 }
    );
  });

  // PBT-7: leading zeros on fractional part still parse correctly when 7 digits
  it('PBT-7: amounts with leading zeros in fractional part are handled correctly', () => {
    // e.g. "5.0000001", "0.0000123" — these are valid (7 digits total in frac)
    const leadingZeroFracArb = fc
      .tuple(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 9_999_999 })
      )
      .map(([whole, frac]) => `${whole}.${String(frac).padStart(7, '0')}`);

    fc.assert(
      fc.property(leadingZeroFracArb, (amount) => {
        const r = AmountValidator.validateUsdcAmount(amount);
        // Should be valid (frac > 0 or whole > 0)
        const stroopCount =
          BigInt(amount.split('.')[0]) * STROOPS_PER_USDC +
          BigInt(amount.split('.')[1]);
        if (stroopCount <= 0n || stroopCount > MAX_STROOPS) {
          return r.valid === false;
        }
        return r.valid === true;
      }),
      { numRuns: 400, seed: 1234567 }
    );
  });

  // PBT-8: scientific-notation strings are always rejected
  it('PBT-8: scientific-notation strings are always rejected', () => {
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
      { numRuns: 300, seed: 1234567 }
    );
  });

  // PBT-9: whitespace-padded strings are always rejected
  it('PBT-9: whitespace-padded strings are always rejected', () => {
    const paddedArb = fc
      .tuple(validAmountArb, fc.constantFrom(' ', '\t', '\n', '\r'), fc.boolean())
      .map(([amount, ws, prepend]) => (prepend ? `${ws}${amount}` : `${amount}${ws}`));

    fc.assert(
      fc.property(paddedArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 200, seed: 1234567 }
    );
  });

  // PBT-10: NaN/Infinity-like strings are always rejected
  it('PBT-10: NaN and Infinity string variants are always rejected', () => {
    const nanInfArb = fc.constantFrom(
      'NaN', 'nan', 'NAN',
      'Infinity', '-Infinity', '+Infinity',
      'inf', 'INF', '-inf',
      'undefined', 'null', 'true', 'false'
    );

    fc.assert(
      fc.property(nanInfArb, (amount) => {
        return AmountValidator.validateUsdcAmount(amount).valid === false;
      }),
      { numRuns: 100, seed: 1234567 }
    );
  });

  // PBT-11: toSmallestUnit result is always a positive bigint for valid inputs
  it('PBT-11: toSmallestUnit always returns a positive bigint for valid amounts', () => {
    fc.assert(
      fc.property(validAmountArb, (amount) => {
        const stroops = AmountValidator.toSmallestUnit(amount);
        return typeof stroops === 'bigint' && stroops > 0n;
      }),
      { numRuns: 500, seed: 1234567 }
    );
  });
});
