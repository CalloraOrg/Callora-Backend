export interface ValidationResult {
  valid: boolean;
  error?: string;
  normalizedAmount?: string;
}

export class AmountValidator {
  private static readonly USDC_DECIMALS = 7;
  private static readonly MAX_AMOUNT = 1_000_000_000;
  private static readonly AMOUNT_PATTERN = /^\d+\.\d{7}$/;

  static validateUsdcAmount(amount: string): ValidationResult {
    // Step 1: Check if string is provided
    if (typeof amount !== 'string') {
      return {
        valid: false,
        error: 'Amount must be a string',
      };
    }

    // Step 2: Check format with regex (exactly 7 decimal places)
    if (!this.AMOUNT_PATTERN.test(amount)) {
      return {
        valid: false,
        error: 'Amount must have exactly 7 decimal places (e.g., "100.0000000")',
      };
    }

    // Step 3: Parse to number
    const numericAmount = parseFloat(amount);

    if (isNaN(numericAmount)) {
      return {
        valid: false,
        error: 'Amount is not a valid number',
      };
    }

    // Step 4: Check positive and non-zero
    if (numericAmount <= 0) {
      return {
        valid: false,
        error: 'Amount must be greater than zero',
      };
    }

    // Step 5: Check maximum limit (1 billion USDC)
    if (numericAmount > this.MAX_AMOUNT) {
      return {
        valid: false,
        error: 'Amount exceeds maximum limit of 1,000,000,000 USDC',
      };
    }

    // Step 6: Normalize format
    const normalizedAmount = numericAmount.toFixed(this.USDC_DECIMALS);

    // All validations passed
    return {
      valid: true,
      normalizedAmount,
    };
  }
}
