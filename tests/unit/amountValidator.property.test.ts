/**
 * @file amountValidator.property.test.ts
 *
 * Property-based tests for `AmountValidator` using fast-check.
 *
 * These tests complement the example-based unit tests in
 * `src/validators/amountValidator.test.ts` by verifying *invariants* that
 * must hold across the entire input domain rather than at hand-picked
 * examples.
 *
 * Properties tested:
 *   1. **Precision** – strings with ≠ 7 decimal digits are always rejected.
 *   2. **Sign**      – negative and zero amounts are always rejected.
 *   3. **Scale**     – amounts above the 1 billion USDC cap are rejected.
 *   4. **Format**    – scientific notation, whitespace, and locale
 *                    separators are never accepted.
 *   5. **Round-trip** – stroop → canonical string → stroop is lossless.
 *   6. **Validity**  – every generated canonical string is accepted.
 *
 * Configuration:
 *   - 100 runs per property (default).
 *   - fast-check's built-in shrinkage surfaces minimal counterexamples
 *     on failure.
 *
 * @see {@link ../../src/validators/amountValidator.ts}
 */

import * as fc from 'fast-check';
import { AmountValidator } from '../../src/validators/amountValidator.js';

// ----------------------------------------------------------------------------
 // Constants & helpers
 // ---------------------------------------------------------------------------

//** Number of stroops in 1 USDC (10^7). */
const STROOPS_PER_USDC = BigInt(10 ** AmountValidator.USDC_DECIMALS);

/** Maximum stroop value that the validator should accept. */
const MAX_STROOPS =
  BigInt(AmountValidator.MAX_AMOUNT) * STROOPS_PER_USDC;

/**
 * Convert a stroop bigint back to its canonical 7-decimal USDC string.
 * Uses pure integer arithmetic"—no floating-point precision loss.
 *
 * @param stroops - A non-negative bigint stroop value.
 * @returns A string of the form `"&lt;whole&gt;.&lt;7-digit-frac&gt;"`.
 */
function stroopsToCanonical(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = stroops % STROOPS_PER_USDC;
  return `${whole}.${String(frac).padStart(AmountValidator.USDC_DECIMALS, '0')}`;
}

// ---------------------------------------------------------------------------
// Arbitraries
+// ---------------------------------------------------------------------------

/**
 * Arbitrary: valid stroop count ∈ [1, MAX_STROOPS].
 *
 * Generating from stroops (instead of from float strings) guarantees
 * every output is exactly representable and satisfies the canonical
 * 7-decimal format.
 */
const validStroopsArb = fc.bigInt({ min: 1n, max: MAX_STROOPS });

/** Arbitrary: valid canonical USDC string derived from a stroop count. */
const validAmountArb = validStroopsArb.map(stroopsToCanonical);

/**
 * Arbitrary: decimal count that is *not* 7 (range 0–15, excluding 7).
 * Used to produce strings with wrong precision.
 */
const wrongDecimalCountArb = fc
  .integer({ min: 0, max: 15 })
  .filter((n) => n !== AmountValidator.USDC_DECIMALS);

/** Default run count – matches the acceptance criteria of 100 runs. */
const NUM_RUNS = 100;

/** Run count for the round-trip property (acceptance criteria: 10k). */
const ROUND_TRIP_RUNS = 10_000;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('AmountValidator – property-based tests (fast-check)', () => {
  // ------------------------------------------------------------------------
  // 1. Precision
  // ------------------------------------------------------------------------

  describe('Precision', () => {
    it('strings with fewer or more than 7 decimal digits are rejected', () => {
      // Build `"&lt;whole&gt;.&lt;frac&gt;"` where `frac` has a length ≠ 7.
      const wrongPrecisionArb = fc
        .tuple(
          fc.integer({ min: 0, max: 999_999 }),
          wrongDecimalCountArb,
        )
        .map(([whole, decimals]) => {
          // Produce a fractional part of exactly `decimals` digits.
          // For 0 decimals the string has no fractional part but still has
          // the dot, ensuring the regex rejects it.
          const frac =
            decimals === 0
              ? ''
              : String(Math.abs(whole) % 10 ** decimals).padStart(decimals, '0');
          return `${Math.abs(whole)}.${frac}`;
        });

      fc.assert(
        fc.property(wrongPrecisionArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          return result.valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('strings without a decimal point are rejected', () => {
      const noDotArb = fc
        .integer({ min: 1, max: 999_999_999 })
        .map(String);

      fc.assert(
        fc.property(noDotArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('valid canonical strings always have exactly 7 decimal digits', () => {
      fc.assert(
        fc.property(validAmountArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          if (!result.valid || !result.normalizedAmount) return false;
          const fracPart = result.normalizedAmount.split('.')[1];
          return fracPart !== undefined && fracPart.length === AmountValidator.USDC_DECIMALS;
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ------------------------------------------------------------------------
  // 2. Sign
  // ------------------------------------------------------------------------

  describe('Sign', () => {
    it('negative amounts (prefixed with "-") are always rejected', () => {
      // Take a valid amount and prepend a minus sign.
      const negativeArb = validAmountArb.map((a) => `-${a}`);

      fc.assert(
        fc.property(negativeArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('explicit positive sign ("+") is always rejected', () => {
      const plusArb = validAmountArb.map((a) => `+${a}`);

      fc.assert(
        fc.property(plusArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('zero amount ("0.0000000") is rejected', () => {
      // Single deterministic check—zero is a boundary, not a distribution.
      const result = AmountValidator.validateUsdcAmount('0.0000000');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/greater than zero/i);
    });

    it('zero amount always throws "must be greater than zero"', () => {
      // Any zero representation with exactly 7 fractional digits must be
      // rejected with the specific zero error message.
      const zeroArb = fc.constantFrom([
        '0.0000000',
        '0.00000000',
        '0000.0000000',
      ]);

      fc.assert(
        fc.property(zeroArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          return result.valid === false && /greater than zero/i.test(result.error ?? '');
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('valid amounts always produce a positive stroop value', () => {
      fc.assert(
        fc.property(validAmountArb, (amount) => {
          const stroops = AmountValidator.toSmallestUnit(amount);
          return typeof stroops === 'bigint' && stroops > 0n;
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ------------------------------------------------------------------------
  // 3. Scale
  // ------------------------------------------------------------------------

  describe('Scale', () => {
    it('amounts above the 1 billion USDC cap are rejected', () => {
      // Generate stroop values that exceed MAX_STROOPS.
      const overMaxArb = fc
        .bigInt({ min: MAX_STROOPS + 1n, max: MAX_STROOPS * 2n })
        .map(stroopsToCanonical);

      fc.assert(
        fc.property(overMaxArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          return result.valid === false && /maximum/i.test(result.error ?? '');
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('amounts at or below the cap are accepted', () => {
      fc.assert(
        fc.property(validAmountArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === true;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('the exact maximum (1,000,000,000.0000000) is accepted', () => {
      const result = AmountValidator.validateUsdcAmount('1000000000.0000000');
      expect(result.valid).toBe(true);
      expect(result.normalizedAmount).toBe('1000000000.0000000');
    });

    it('one stroop above the maximum is rejected', () => {
      const oneOver = stroopsToCanonical(MAX_STROOPS + 1n);
      const result = AmountValidator.validateUsdcAmount(oneOver);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/maximum/i);
    });
  });

  // ------------------------------------------------------------------------
  // 4. Format rejection
  // ------------------------------------------------------------------------

  describe('Format rejection', () => {
    it('scientific-notation strings are always rejected', () => {
      const sciArb = fc
        .tuple(
          fc.integer({ min: 1, max: 999_999 }),
          fc.integer({ min: 1, max: 9 }),
          fc.constantFrom('e', 'E'),
          fc.constantFrom('', '+', '-'),
        )
        .map(([mantissa, exp, e, sign]) => `${mantissa}${e}${sign}${exp}`);

      fc.assert(
        fc.property(sciArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('whitespace-padded strings are always rejected', () => {
      const paddedArb = fc
        .tuple(
          validAmountArb,
          fc.constantFrom(' ', '\t', '\n', '\r'),
          fc.boolean(),
        )
        .map(([amount, ws, prepend]) =>
          prepend ? `${ws}${amount}` : `${amount}${ws}`,
        );

      fc.assert(
        fc.property(paddedArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('locale-separator strings (commas, underscores) are always rejected', () => {
      // Insert a comma or underscore at a random position in the whole part.
      const localeArb = fc
        .tuple(
          fc.integer({ min: 1_000, max: 999_999_999 }),
          fc.constantFrom(',', '_'),
        )
        .map(([n, sep]) => {
          const s = String(n);
          const pos = Math.max(1, Math.floor(s.length / 2));
          const withSep = s.slice(0, pos) + sep + s.slice(pos);
          return `${withSep}.0000000`;
        });

      fc.assert(
        fc.property(localeArb, (amount) => {
          return AmountValidator.validateUsdcAmount(amount).valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('non-string inputs are rejected', () => {
      // Exercise a variety of JS value types.
      const nonStringArb = fc.oneof(
        fc.integer(),
        fc.double(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
      );

      fc.assert(
        fc.property(nonStringArb, (value) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = AmountValidator.validateUsdcAmount(value as any);
          return result.valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ------------------------------------------------------------------------
  // 5. Round-trip integrity
  // ------------------------------------------------------------------------

  describe('Round-trip integrity', () => {
    it('stroop → canonical string → stroop is lossless (10k runs)', () => {
      fc.assert(
        fc.property(validStroopsArb, (stroops) => {
          const canonical = stroopsToCanonical(stroops);
          const roundTripped = AmountValidator.toSmallestUnit(canonical);
          return roundTripped === stroops;
        }),
        { numRuns: ROUND_TRIP_RUNS },
      );
    });

    it('normalizedAmount always equals the original valid input', () => {
      fc.assert(
        fc.property(validAmountArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          return result.normalizedAmount === amount;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('format(parse(x)) normalises x for all valid decimals', () => {
      // Generate amounts with a variable number of fractional digits
      // (0–7) and verify that validation normalises to exactly 7 digits
      // without changing the underlying value.
      const variablePrecisionArb = fc
        .tuple(fc.bigInt({ min: 1n, max: MAX_STROOPS }), fc.integer({ min: 0, max: 7 }))
        .map(([stroops, digits]) => {
          const whole = stroops / STROOPS_PER_USDC;
          const frac = stroops % STROOPS_PER_USDC;
          const fracFull = String(frac).padStart(AmountValidator.USDC_DECIMALS, '0');
          // Truncate to `digits` fractional digits.
          const fracTruncated = fracFull.slice(0, digits);
          return digits === 0 ? `${whole}` : `${whole}.${fracTruncated}`;
        })
        .filter((amount) => {
          // Only keep amounts that are non-zero and within the cap.
          const stroops = AmountValidator.toSmallestUnit(amount);
          return stroops > 0n && stroops <= MAX_STROOPS;
        });

      fc.assert(
        fc.property(variablePrecisionArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          if (!result.valid || !result.normalizedAmount) return false;
          // Normalised output must have exactly 7 fractional digits.
          const fracPart = result.normalizedAmount.split('.')[1];
          if (fracPart === undefined || fracPart.length !== AmountValidator.USDC_DECIMALS) return false;
          // Round-trip through stroops must preserve the value.
          const originalStroops = AmountValidator.toSmallestUnit(amount);
          const normalizedStroops = AmountValidator.toSmallestUnit(result.normalizedAmount);
          return originalStroops === normalizedStroops;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('format output never has trailing zeros beyond the 7-decimal scale', () => {
      // Canonical output must always carry exactly 7 fractional digits,
      // with no extra trailing zeros and no trailing dot.
      fc.assert(
        fc.property(validAmountArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          if (!result.valid || !result.normalizedAmount) return false;
          const normalized = result.normalizedAmount;
          // Must not end with a dot.
          if (normalized.endsWith('.')) return false;
          // Fractional part must be exactly 7 digits.
          const fracPart = normalized.split('.')[1];
          if (fracPart === undefined || fracPart.length !== AmountValidator.USDC_DECIMALS) return false;
          // No extra trailing zeros beyond the 7-decimal scale.
          return !/\.0+0/.test(normalized);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ------------------------------------------------------------------------
  // 6. Precision (8 fractional digits)
  // ------------------------------------------------------------------------

  describe('Eight fractional digits', () => {
    it('inputs with 8 fractional digits always throw', () => {
      // Any amount with exactly 8 fractional digits must be rejected,
      // regardless of the whole part or the fractional digits.
      const eightDigitArb = fc
        .tuple(
          fc.bigInt({ min: 0n, max: 999_999_999n }),
          fc.integer({ min: 0, max: 99_999_999 }),
        )
        .map(([whole, frac]) => {
          const fracStr = String(frac).padStart(8, '0').slice(0, 8);
          return `${whole}.${fracStr}`;
        });

      fc.assert(
        fc.property(eightDigitArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          return result.valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('8-digit fractional inputs with non-zero digits always throw', () => {
      const nonZeroEightArb = fc
        .tuple(
          fc.bigInt({ min: 1n, max: 999_999_999n }),
          fc.integer({ min: 1, max: 99_999_999 }),
        )
        .map(([whole, frac]) => {
          const fracStr = String(frac).padStart(8, '0').slice(0, 8);
          return `${whole}.${fracStr}`;
        });

      fc.assert(
        fc.property(nonZeroEightArb, (amount) => {
          const result = AmountValidator.validateUsdcAmount(amount);
          return result.valid === false;
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ------------------------------------------------------------------------
  // 7. Large whole numbers (bigint precision)
  // ------------------------------------------------------------------------

  describe('Large whole numbers', () => {
    it('very large whole numbers do not lose precision', () => {
      // Generate values near the cap with arbitrary fractional parts and
      // verify the stroop round-trip is exact.
      const largeArb = fc
        .bigInt({ min: 1n, max: MAX_STROOPS })
        .map(stroopsToCanonical);

      fc.assert(
        fc.property(largeArb, (amount) => {
          const stroops = AmountValidator.toSmallestUnit(amount);
          const roundTrip = AmountValidator.toSmallestUnit(
            AmountValidator.validateUsdcAmount(amount).normalizedAmount ?? amount,
          );
          return stroops === roundTrip;
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('exact maximum converts to exactly MAX_STROOPS', () => {
      const maxString = stroopsToCanonical(MAX_STROOPS);
      const stroops = AmountValidator.toSmallestUnit(maxString);
      expect(stroops).toBe(MAX_STROOPS);
    });
  });
});
