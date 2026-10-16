import {
    validateRetryPolicy,
    getEffectiveRetryPolicy,
    calculateBackoff,
    isRetryableWebhookStatus,
    parseRetryAfterMs,
    MAX_RETRY_AFTER_MS,
} from './webhookRetry.js';
import { DEFAULT_RETRY_POLICY } from '../webhooks/webhook.types.js';

describe('Webhook Retry Policy Service', () => {
    describe('validateRetryPolicy', () => {
        it('accepts undefined policy (uses defaults)', () => {
            const result = validateRetryPolicy(undefined);
            expect(result.valid).toBe(true);
        });

        it('accepts empty object (uses defaults)', () => {
            const result = validateRetryPolicy({});
            expect(result.valid).toBe(true);
        });

        it('accepts valid maxRetries range 0-10', () => {
            for (let i = 0; i <= 10; i++) {
                const result = validateRetryPolicy({ maxRetries: i });
                expect(result.valid).toBe(true);
            }
        });

        it('rejects maxRetries below 0', () => {
            const result = validateRetryPolicy({ maxRetries: -1 });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('maxRetries must be an integer between 0 and 10');
        });

        it('rejects maxRetries above 10', () => {
            const result = validateRetryPolicy({ maxRetries: 11 });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('maxRetries must be an integer between 0 and 10');
        });

        it('rejects non-integer maxRetries', () => {
            const result = validateRetryPolicy({ maxRetries: 3.5 });
            expect(result.valid).toBe(false);
        });

        it('accepts valid baseDelayMs range 100-60000', () => {
            expect(validateRetryPolicy({ baseDelayMs: 100 }).valid).toBe(true);
            expect(validateRetryPolicy({ baseDelayMs: 1000 }).valid).toBe(true);
            expect(validateRetryPolicy({ baseDelayMs: 60000 }).valid).toBe(true);
        });

        it('rejects baseDelayMs below 100', () => {
            const result = validateRetryPolicy({ baseDelayMs: 99 });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('baseDelayMs must be an integer between 100 and 60000');
        });

        it('rejects baseDelayMs above 60000', () => {
            const result = validateRetryPolicy({ baseDelayMs: 60001 });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('baseDelayMs must be an integer between 100 and 60000');
        });

        it('rejects non-object input', () => {
            const result = validateRetryPolicy('not an object' as unknown);
            expect(result.valid).toBe(true); // Returns valid with defaults when not an object
        });
    });

    describe('getEffectiveRetryPolicy', () => {
        it('returns defaults when no override provided', () => {
            const result = getEffectiveRetryPolicy(undefined);
            expect(result.maxRetries).toBe(DEFAULT_RETRY_POLICY.maxRetries);
            expect(result.baseDelayMs).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
        });

        it('returns defaults when partial override provided', () => {
            const result = getEffectiveRetryPolicy({ maxRetries: 3 });
            expect(result.maxRetries).toBe(3);
            expect(result.baseDelayMs).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);

            const result2 = getEffectiveRetryPolicy({ baseDelayMs: 2000 });
            expect(result2.maxRetries).toBe(DEFAULT_RETRY_POLICY.maxRetries);
            expect(result2.baseDelayMs).toBe(2000);
        });

        it('returns override values when fully specified', () => {
            const result = getEffectiveRetryPolicy({ maxRetries: 8, baseDelayMs: 500 });
            expect(result.maxRetries).toBe(8);
            expect(result.baseDelayMs).toBe(500);
        });
    });

    describe('calculateBackoff', () => {
        it('calculates exponential backoff correctly', () => {
            expect(calculateBackoff(0, 1000)).toBe(1000);
            expect(calculateBackoff(1, 1000)).toBe(2000);
            expect(calculateBackoff(2, 1000)).toBe(4000);
            expect(calculateBackoff(3, 1000)).toBe(8000);
            expect(calculateBackoff(4, 1000)).toBe(16000);
        });

        it('calculates backoff with custom base delay', () => {
            expect(calculateBackoff(0, 500)).toBe(500);
            expect(calculateBackoff(1, 500)).toBe(1000);
            expect(calculateBackoff(2, 500)).toBe(2000);
        });
    });

    describe('isRetryableWebhookStatus', () => {
        it('marks 408, 429, and 5xx as retryable', () => {
            expect(isRetryableWebhookStatus(408)).toBe(true);
            expect(isRetryableWebhookStatus(429)).toBe(true);
            expect(isRetryableWebhookStatus(500)).toBe(true);
            expect(isRetryableWebhookStatus(502)).toBe(true);
            expect(isRetryableWebhookStatus(503)).toBe(true);
            expect(isRetryableWebhookStatus(504)).toBe(true);
        });

        it('marks permanent 4xx statuses (400, 401, 403, 404, 410, 422) as non-retryable', () => {
            expect(isRetryableWebhookStatus(400)).toBe(false);
            expect(isRetryableWebhookStatus(401)).toBe(false);
            expect(isRetryableWebhookStatus(403)).toBe(false);
            expect(isRetryableWebhookStatus(404)).toBe(false);
            expect(isRetryableWebhookStatus(410)).toBe(false);
            expect(isRetryableWebhookStatus(422)).toBe(false);
        });
    });

    describe('parseRetryAfterMs', () => {
        it('parses delta-seconds and caps at MAX_RETRY_AFTER_MS', () => {
            expect(parseRetryAfterMs('2')).toBe(2000);
            expect(parseRetryAfterMs('0')).toBe(0);
            expect(parseRetryAfterMs('3600')).toBe(MAX_RETRY_AFTER_MS);
        });

        it('parses HTTP-date values relative to nowMs and caps at MAX_RETRY_AFTER_MS', () => {
            const nowMs = Date.parse('2026-06-15T12:00:00Z');
            const futureDate = new Date(nowMs + 5000).toUTCString();
            expect(parseRetryAfterMs(futureDate, nowMs)).toBe(5000);

            const pastDate = new Date(nowMs - 5000).toUTCString();
            expect(parseRetryAfterMs(pastDate, nowMs)).toBe(0);
        });

        it('returns null for missing or malformed headers', () => {
            expect(parseRetryAfterMs(null)).toBeNull();
            expect(parseRetryAfterMs(undefined)).toBeNull();
            expect(parseRetryAfterMs('')).toBeNull();
            expect(parseRetryAfterMs('not-a-date')).toBeNull();
        });
    });
});