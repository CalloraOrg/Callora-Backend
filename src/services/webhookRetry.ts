import { RetryPolicy, DEFAULT_RETRY_POLICY } from '../webhooks/webhook.types.js';

export interface RetryPolicyValidationResult {
    valid: boolean;
    error?: string;
}

/**
 * Validates a retry policy object at the API boundary.
 * 
 * Constraints:
 * - maxRetries: 0-10 (0 = no retries, useful for testing)
 * - baseDelayMs: 100-60000 (100ms to 60s to prevent abuse)
 * 
 * All fields are optional; undefined means use default values.
 */
export function validateRetryPolicy(policy: unknown): RetryPolicyValidationResult {
    if (!policy || typeof policy !== 'object') {
        return { valid: true }; // No override provided, use defaults
    }

    const p = policy as Partial<RetryPolicy>;

    if (p.maxRetries !== undefined) {
        if (!Number.isInteger(p.maxRetries) || p.maxRetries < 0 || p.maxRetries > 10) {
            return {
                valid: false,
                error: 'maxRetries must be an integer between 0 and 10',
            };
        }
    }

    if (p.baseDelayMs !== undefined) {
        if (!Number.isInteger(p.baseDelayMs) || p.baseDelayMs < 100 || p.baseDelayMs > 60000) {
            return {
                valid: false,
                error: 'baseDelayMs must be an integer between 100 and 60000',
            };
        }
    }

    return { valid: true };
}

/**
 * Normalizes a retry policy by merging with defaults.
 * Returns the effective retry policy for a subscription.
 */
export function getEffectiveRetryPolicy(policy?: RetryPolicy): {
    maxRetries: number;
    baseDelayMs: number;
} {
    return {
        maxRetries: policy?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
        baseDelayMs: policy?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    };
}

/**
 * Calculates exponential backoff delay for a given attempt.
 * Uses the configured base delay and doubles after each attempt.
 */
export function calculateBackoff(attempt: number, baseDelayMs: number): number {
    return baseDelayMs * Math.pow(2, attempt);
}