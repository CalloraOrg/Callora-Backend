import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import {
  parseUsdcToContractUnits,
  formatContractUnitsToUsdc,
  USDC_7_DECIMAL_FACTOR,
  USDC_DECIMALS,
  STROOPS_PER_USDC,
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
