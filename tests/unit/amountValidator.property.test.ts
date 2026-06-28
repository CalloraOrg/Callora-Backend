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
 *                      separators are never accepted.
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

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Number of stroops in 1 USDC (10^7). */
const STROOPS_PER_USDC = BigInt(10 ** AmountValidator.USDC_DECIMALS);

/** Maximum stroop value that the validator should accept. */
const MAX_STROOPS =
  BigInt(AmountValidator.MAX_AMOUNT) * STROOPS_PER_USDC;

/**
 * Convert a stroop bigint back to its canonical 7-decimal USDC string.
 * Uses pure integer arithmetic—no floating-point precision loss.
 *
 * @param stroops - A non-negative bigint stroop value.
 * @returns A string of the form `"<whole>.<7-digit-frac>"`.
 */
function stroopsToCanonical(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = stroops % STROOPS_PER_USDC;
  return `${whole}.${String(frac).padStart(AmountValidator.USDC_DECIMALS, '0')}`;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('AmountValidator – property-based tests (fast-check)', () => {
  // -----------------------------------------------------------------------
  // 1. Precision
  // -----------------------------------------------------------------------

  describe('Precision', () => {
    it('strings with fewer or more than 7 decimal digits are rejected', () => {
      // Build `"<whole>.<frac>"` where `frac` has a length ≠ 7.
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

  // -----------------------------------------------------------------------
  // 2. Sign
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // 3. Scale
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // 4. Format rejection
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // 5. Round-trip integrity
  // -----------------------------------------------------------------------

  describe('Round-trip integrity', () => {
    it('stroop → canonical string → stroop is lossless', () => {
      fc.assert(
        fc.property(validStroopsArb, (stroops) => {
          const canonical = stroopsToCanonical(stroops);
          const roundTripped = AmountValidator.toSmallestUnit(canonical);
          return roundTripped === stroops;
        }),
        { numRuns: NUM_RUNS },
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

    it('toSmallestUnit result is always a positive bigint for valid amounts', () => {
      fc.assert(
        fc.property(validAmountArb, (amount) => {
          const stroops = AmountValidator.toSmallestUnit(amount);
          return typeof stroops === 'bigint' && stroops > 0n;
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // -----------------------------------------------------------------------
  // 6. Counterexample shrinkage verification
  // -----------------------------------------------------------------------

  describe('Shrinkage', () => {
    it('fast-check shrinks to a minimal counterexample on a forced failure', () => {
      // We intentionally introduce a property that fails for amounts > 500 USDC
      // and verify that fast-check's shrinkage produces a counterexample.
      const threshold = 500n * STROOPS_PER_USDC;

      let shrunkCounterexample: string | undefined;

      try {
        fc.assert(
          fc.property(validAmountArb, (amount) => {
            const stroops = AmountValidator.toSmallestUnit(amount);
            // This will fail for any amount > 500 USDC.
            return stroops <= threshold;
          }),
          { numRuns: NUM_RUNS },
        );
      } catch (err: unknown) {
        // fast-check throws a `Property failed` error with a
        // `counterexample` array on the error object.
        if (err instanceof Error && 'counterexample' in err) {
          const ce = (err as Error & { counterexample: unknown[] }).counterexample;
          shrunkCounterexample = ce?.[0] as string;
        }
      }

      // Verify that a counterexample was produced and that shrinkage
      // brought it close to the boundary (≤ 501 USDC is a reasonable
      // shrink target).
      expect(shrunkCounterexample).toBeDefined();
      const shrunkStroops = AmountValidator.toSmallestUnit(shrunkCounterexample!);
      expect(shrunkStroops).toBeGreaterThan(threshold);

      // Shrinkage should bring the counterexample close to the 500 USDC
      // boundary. We allow a generous margin of 1 USDC above threshold.
      const onUsdcAbove = threshold + STROOPS_PER_USDC;
      expect(shrunkStroops).toBeLessThanOrEqual(onUsdcAbove);
    });
  });
});
