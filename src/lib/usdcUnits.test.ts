import { describe, it, expect } from '@jest/globals';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  parseUsdcToContractUnits,
  formatContractUnitsToUsdc,
  USDC_7_DECIMAL_FACTOR,
  USDC_DECIMALS,
  STROOPS_PER_USDC,
  USDC_UNITS_PER_USDC,
  parseUsdcToUnits,
  formatUnitsToUsdc,
  formatUnitsToUsdcFixed,
} from './usdcUnits.js';
describe('usdcUnits module', () => {
  describe('parseUsdcToContractUnits', () => {
    it('parses fractional USDC strings into exact contract units', () => {
      expect(parseUsdcToContractUnits('0.0012345')).toBe(12345n);
      expect(parseUsdcToContractUnits('1.5')).toBe(15000000n);
      expect(parseUsdcToContractUnits('0.0000001')).toBe(1n);
      expect(parseUsdcToContractUnits('1')).toBe(10000000n);
      expect(parseUsdcToContractUnits('1.0000000')).toBe(10000000n);
      expect(parseUsdcToContractUnits('  0.01  ')).toBe(100000n);
    });

    it('rejects invalid, zero, or non-positive amounts', () => {
      expect(() => parseUsdcToContractUnits('0')).toThrow('must be greater than zero');
      expect(() => parseUsdcToContractUnits('0.0')).toThrow('must be greater than zero');
      expect(() => parseUsdcToContractUnits('0.0000000')).toThrow('must be greater than zero');
      expect(() => parseUsdcToContractUnits('-1')).toThrow('positive decimal');
      expect(() => parseUsdcToContractUnits('-0.5')).toThrow('positive decimal');
      expect(() => parseUsdcToContractUnits('abc')).toThrow('positive decimal');
      expect(() => parseUsdcToContractUnits('')).toThrow('positive decimal');
      expect(() => parseUsdcToContractUnits('1.12345678')).toThrow('at most 7 fractional digits');
    });
  });

  describe('formatContractUnitsToUsdc', () => {
    it('formats contract units into canonical decimal USDC without trailing zeroes', () => {
      expect(formatContractUnitsToUsdc(0n)).toBe('0');
      expect(formatContractUnitsToUsdc(1n)).toBe('0.0000001');
      expect(formatContractUnitsToUsdc(12345n)).toBe('0.0012345');
      expect(formatContractUnitsToUsdc(100000n)).toBe('0.01');
      expect(formatContractUnitsToUsdc(10000000n)).toBe('1');
      expect(formatContractUnitsToUsdc(15000000n)).toBe('1.5');
      expect(formatContractUnitsToUsdc(10500000n)).toBe('1.05');
    });

    it('throws when formatting a negative amount', () => {
      expect(() => formatContractUnitsToUsdc(-1n)).toThrow('amount must be non-negative');
    });

    it('exports constants accurately', () => {
      expect(USDC_DECIMALS).toBe(7);
      expect(USDC_7_DECIMAL_FACTOR).toBe(10000000n);
      expect(STROOPS_PER_USDC).toBe(10000000n);
    });
  });

  describe('Scenario 8: Property test (fast-check)', () => {
    it('parse, format, and re-parse is the identity for random 7-decimal positive amounts', () => {
      // Arbitrary non-negative integer whole part (0 to 1,000,000)
      // and fractional digits 1 to 7 chars
      const decimalArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 0, max: 9_999_999 }),
      ).map(([whole, fracLen, fracSeed]) => {
        const rawFrac = fracSeed.toString().padStart(7, '0').slice(0, fracLen);
        const fracTrimmed = rawFrac.replace(/0+$/, '');
        if (whole === 0 && (!fracTrimmed || fracTrimmed === '')) {
          return '0.0000001';
        }
        return fracTrimmed ? `${whole}.${fracTrimmed}` : `${whole}`;
      }).filter((s) => s !== '0');

      fc.assert(
        fc.property(decimalArbitrary, (usdcStr) => {
          const units = parseUsdcToContractUnits(usdcStr);
          expect(units).toBeGreaterThan(0n);
          const formatted = formatContractUnitsToUsdc(units);
          const roundTrippedUnits = parseUsdcToContractUnits(formatted);
          expect(roundTrippedUnits).toBe(units);
          expect(formatted).toBe(usdcStr);
        }),
        { numRuns: 1000 },
      );
    });
  });
});

describe('parseUsdcToUnits', () => {
  it('parses whole USDC amounts', () => {
    assert.equal(parseUsdcToUnits('0'), 0n);
    assert.equal(parseUsdcToUnits('1'), USDC_UNITS_PER_USDC);
    assert.equal(parseUsdcToUnits('5'), 50000000n);
    assert.equal(parseUsdcToUnits('100'), 1_000_000_000n);
  });

  it('parses fractional USDC amounts up to 7 decimals', () => {
    assert.equal(parseUsdcToUnits('0.0000001'), 1n);
    assert.equal(parseUsdcToUsdcUnitsFix('0.001'), 10000n);
    assert.equal(parseUsdcToUnits('12.3456789'), 123456789n);
    assert.equal(parseUsdcToUnits('1.5'), 15000000n);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(parseUsdcToUnits('  5  '), 50000000n);
    assert.equal(parseUsdcToUnits('\t0.25\n'), 2500000n);
  });

  it('rejects more than 7 fractional digits', () => {
    assert.throws(() => parseUsdcToUnits('0.00000001'), /Invalid USDC amount/);
  });

  it('rejects negative values and malformed strings', () => {
    assert.throws(() => parseUsdcToUnits('-1'), /Invalid USDC amount/);
    assert.throws(() => parseUsdcToUnits('abc'), /Invalid USDC amount/);
    assert.throws(() => parseUsdcToUnits('1.2.3'), /Invalid USDC amount/);
    assert.throws(() => parseUsdcToUnits(''), /Invalid USDC amount/);
    assert.throws(() => parseUsdcToUnits('1e-7'), /Invalid USDC amount/);
  });
});

describe('formatUnitsToUsdc', () => {
  it('formats integers without a decimal point', () => {
    assert.equal(formatUnitsToUsdc(0n), '0');
    assert.equal(formatUnitsToUsdc(60000000n), '6');
    assert.equal(formatUnitsToUsdc(1_000_000_000n), '100');
  });

  it('strips trailing fractional zeros', () => {
    assert.equal(formatUnitsToUsdc(15000000n), '1.5');
    assert.equal(formatUnitsToUsdc(123456789n), '12.3456789');
    assert.equal(formatUnitsToUsdc(10000n), '0.001');
    assert.equal(formatUnitsToUsdc(1n), '0.0000001');
  });

  it('rejects negative units', () => {
    assert.throws(() => formatUnitsToUsdc(-1n), /negative/);
  });
});

describe('formatUnitsToUsdcFixed', () => {
  it('pads to exactly 7 fractional digits', () => {
    assert.equal(formatUnitsToUsdcFixed(60000000n), '6.0000000');
    assert.equal(formatUnitsToUsdcFixed(0n), '0.0000000');
    assert.equal(formatUnitsToUsdcFixed(1n), '0.0000001');
    assert.equal(formatUnitsToUsdcFixed(10000n), '0.0010000');
    assert.equal(formatUnitsToUsdcFixed(123456789n), '12.3456789');
  });

  it('rejects negative units', () => {
    assert.throws(() => formatUnitsToUsdcFixed(-1n), /negative/);
  });
});

describe('round-trip property (fast-check)', () => {
  // Random 7-decimal non-negative amounts: sum of parsed units must equal the
  // formatted total parsed back (issue #1512 test-plan row 2).
  const sevenDecimalArb = fc
    .bigIntN(64)
    .filter((n) => n >= 0n)
    .map((units) => formatUnitsToUsdcFixed(units));

  it('parse(formatFixed(units)) === units for every non-negative bigint', () => {
    fc.assert(
      fc.property(fc.bigIntN(70).filter((n) => n >= 0n), (units) => {
        assert.equal(parseUsdcToUnits(formatUnitsToUsdcFixed(units)), units);
      }),
    );
  });

  it('Σ parse(amount) === parse(format(Σ units)) for any list of 7-decimal amounts', () => {
    fc.assert(
      fc.property(fc.array(sevenDecimalArb, { minLength: 1, maxLength: 50 }), (amounts) => {
        const sumUnits = amounts.reduce((acc, a) => acc + parseUsdcToUnits(a), 0n);
        const formatted = formatUnitsToUsdcFixed(sumUnits);
        assert.equal(parseUsdcToUnits(formatted), sumUnits);
      }),
    );
  });

  it('formatUnitsToUsdcFixed and formatUnitsToUsdc parse back identically', () => {
    fc.assert(
      fc.property(sevenDecimalArb, (amount) => {
        const units = parseUsdcToUnits(amount);
        assert.equal(parseUsdcToUnits(formatUnitsToUsdc(units)), units);
      }),
    );
  });
});

// Helper used only inside this file's parse assertions (kept local to avoid
// exporting a confusingly-named alias). Renamed to avoid shadowing in tests.
function parseUsdcToUsdcUnitsFix(amount: string): bigint {
  return parseUsdcToUnits(amount);
}
