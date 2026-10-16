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
        maxRetries: policy?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries ?? 3,
        baseDelayMs: policy?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs ?? 1000,
    };
}

/**
 * Calculates exponential backoff delay for a given attempt.
 * Uses the configured base delay and doubles after each attempt.
 */
export function calculateBackoff(attempt: number, baseDelayMs: number): number {
    return baseDelayMs * Math.pow(2, attempt);
}

/**
 * Upper bound for Retry-After header delays (60 seconds) so a misconfigured
 * or hostile webhook receiver cannot stall a dispatcher worker indefinitely.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Classifies whether an HTTP status code from a webhook receiver is transient
 * and should be retried.
 *
 * Retryable:
 *   - 408 Request Timeout
 *   - 429 Too Many Requests
 *   - 5xx Server Errors (500-599)
 *
 * Non-retryable (permanent failures):
 *   - All other 4xx responses (e.g. 400, 401, 403, 404, 410, 422)
 *   - 2xx / 3xx responses
 */
export function isRetryableWebhookStatus(status: number): boolean {
    if (status === 408 || status === 429) {
        return true;
    }
    return status >= 500 && status <= 599;
}

/**
 * Parses an HTTP `Retry-After` header value (delta-seconds or HTTP-date) into
 * a delay in milliseconds, clamped to `[0, maxDelayMs]`.
 *
 * Returns `null` when the header is absent or cannot be parsed.
 */
export function parseRetryAfterMs(
    headerValue: string | null | undefined,
    nowMs: number = Date.now(),
    maxDelayMs: number = MAX_RETRY_AFTER_MS
): number | null {
    if (!headerValue || typeof headerValue !== 'string') {
        return null;
    }

    const trimmed = headerValue.trim();
    if (!trimmed) {
        return null;
    }

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (!Number.isFinite(seconds) || seconds < 0) {
            return null;
        }
        return Math.min(Math.ceil(seconds * 1000), maxDelayMs);
    }

    const parsedDateMs = Date.parse(trimmed);
    if (!Number.isNaN(parsedDateMs)) {
        const deltaMs = Math.max(0, parsedDateMs - nowMs);
        return Math.min(deltaMs, maxDelayMs);
    }

    return null;
}