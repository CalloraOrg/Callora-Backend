/**
 * USDC contract-unit arithmetic helpers.
 *
 * The Soroban USDC contract represents amounts as i128 integer values where
 * 1 USDC = 10,000,000 (10^7) contract units.  All domain arithmetic on USDC
 * amounts uses these bigint units so that sums, comparisons and splits are
 * exact regardless of the number of events or the size of individual charges.
 *
 * Boundary conversion rules:
 *   - SQL READ  → DECIMAL/NUMERIC column returned as a string → parseUsdcToUnits()
 *   - SQL WRITE → formatUnitsToUsdc() produces a minimal decimal string stored in DECIMAL column
 *   - API / webhook out → formatUnitsToUsdcFixed() produces the canonical 7-decimal string
 *                         (e.g. "6.0000000") that external consumers expect
 *   - API in  → amounts already arrive as decimal strings; billing.ts handles them separately
 *
 * Design:
 *   parseUsdcToUnits  accepts "0" (returns 0n) — free events are valid
 *   parseUsdcToContractUnits in billing.ts keeps its >0 guard for deduction requests
 */

export const USDC_UNITS_PER_USDC = 10_000_000n;

/**
 * Parse a decimal USDC string (up to 7 fractional digits) into bigint
 * contract units.  Accepts "0".  Rejects negative values and strings with
 * more than 7 fractional digits.
 *
 * @example
 * parseUsdcToUnits("12.3456789") // => 123456789n
 * parseUsdcToUnits("0")          // => 0n
 * parseUsdcToUnits("5")          // => 50000000n
 */
export function parseUsdcToUnits(amountUsdc: string): bigint {
  const trimmed = amountUsdc.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(
      `Invalid USDC amount: "${amountUsdc}". Must be a non-negative decimal with at most 7 fractional digits.`,
    );
  }

  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionalPart + '0000000').slice(0, 7));
  return whole * USDC_UNITS_PER_USDC + fraction;
}

/**
 * Format bigint contract units to a minimal USDC decimal string.
 * Trailing fractional zeros are stripped; integers have no decimal point.
 *
 * @example
 * formatUnitsToUsdc(123456789n) // => "12.3456789"
 * formatUnitsToUsdc(60000000n)  // => "6"
 * formatUnitsToUsdc(0n)         // => "0"
 */
export function formatUnitsToUsdc(units: bigint): string {
  if (units < 0n) {
    throw new Error('Cannot format negative contract units.');
  }

  const whole = units / USDC_UNITS_PER_USDC;
  const fraction = units % USDC_UNITS_PER_USDC;

  if (fraction === 0n) {
    return whole.toString();
  }

  return `${whole.toString()}.${fraction.toString().padStart(7, '0').replace(/0+$/, '')}`;
}

/**
 * Format bigint contract units to a fixed 7-decimal USDC string.
 * This is the canonical wire format used in API and webhook payloads
 * (e.g. "6.0000000", "0.0000001").
 *
 * @example
 * formatUnitsToUsdcFixed(60000000n)  // => "6.0000000"
 * formatUnitsToUsdcFixed(0n)         // => "0.0000000"
 * formatUnitsToUsdcFixed(1n)         // => "0.0000001"
 */
export function formatUnitsToUsdcFixed(units: bigint): string {
  if (units < 0n) {
    throw new Error('Cannot format negative contract units.');
  }

  const whole = units / USDC_UNITS_PER_USDC;
  const fraction = units % USDC_UNITS_PER_USDC;
  return `${whole.toString()}.${fraction.toString().padStart(7, '0')}`;
}
