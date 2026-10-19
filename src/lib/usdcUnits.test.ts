import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  USDC_UNITS_PER_USDC,
  parseUsdcToUnits,
  formatUnitsToUsdc,
  formatUnitsToUsdcFixed,
} from './usdcUnits.js';

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
