/**
 * Canonical USDC contract units conversion module.
 *
 * Canonical storage unit: 7-decimal integer contract units ("stroops").
 * 1 USDC = 10,000,000 contract units.
 *
 * All amounts written to and read from the database (usage_events, revenue_ledger)
 * represent exact integer contract units. No floating point arithmetic is used.
 */

export const USDC_DECIMALS = 7;
export const USDC_7_DECIMAL_FACTOR = 10_000_000n;
export const STROOPS_PER_USDC = 10_000_000n;

/**
 * Parses a decimal USDC string (e.g. "0.01", "1.5", "0.0012345") into
 * exact integer contract units (bigint) without any floating-point intermediate.
 *
 * Rejects non-positive amounts, invalid numeric formats, or amounts with
 * more than 7 fractional digits.
 */
export function parseUsdcToContractUnits(amountUsdc: string): bigint {
  const trimmed = amountUsdc.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(
      "amountUsdc must be a positive decimal with at most 7 fractional digits",
    );
  }

  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionalPart + "0000000").slice(0, 7));
  const result = whole * USDC_7_DECIMAL_FACTOR + fraction;

  if (result <= 0n) {
    throw new Error("amountUsdc must be greater than zero");
  }

  return result;
}

/**
 * Formats exact integer contract units (bigint) into a canonical decimal USDC string
 * (e.g. 100000n -> "0.01", 15000000n -> "1.5", 12345n -> "0.0012345", 0n -> "0").
 * Trailing zeroes in the fractional part are omitted.
 */
export function formatContractUnitsToUsdc(amount: bigint): string {
  if (amount < 0n) {
    throw new Error("amount must be non-negative");
  }

  const whole = amount / USDC_7_DECIMAL_FACTOR;
  const fraction = amount % USDC_7_DECIMAL_FACTOR;

  if (fraction === 0n) {
    return whole.toString();
  }

  return `${whole.toString()}.${fraction
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "")}`;
}

// ---------------------------------------------------------------------------
// Non-throwing-on-zero helpers used by settlement, invoice and usage code.
// parseUsdcToUnits accepts "0" (returns 0n) — free events are valid.
// formatUnitsToUsdcFixed produces the canonical 7-decimal wire format used in
// API and webhook payloads (e.g. "6.0000000").
// ---------------------------------------------------------------------------

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
 * Boundary conversion for a JS number USDC amount (for example a configured
 * threshold). Rounds to the 7-decimal grid, then parses the canonical string.
 */
export function usdcNumberToUnits(amountUsdc: number): bigint {
  return parseUsdcToUnits(amountUsdc.toFixed(7));
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
