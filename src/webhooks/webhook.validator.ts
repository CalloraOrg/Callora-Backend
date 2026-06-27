import { URL } from 'url';
import dns from 'dns/promises';
import ipRangeCheck from 'ip-range-check';
import type { WebhookRetryPolicy } from './webhook.types.js';

const BLOCKED_RANGES = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',   // link-local
    '::1/128',          // IPv6 loopback
    'fc00::/7',         // IPv6 unique local
    '0.0.0.0/8',
    '100.64.0.0/10',    // CGNAT
    '198.18.0.0/15',
    '240.0.0.0/4',
];

export class WebhookValidationError extends Error {}

type RetryPolicyField = keyof WebhookRetryPolicy;

const RETRY_POLICY_LIMITS = {
    maxAttempts: { min: 1, max: 20 },
    baseDelayMs: { min: 0, max: 300_000 },
    maxDelayMs: { min: 0, max: 600_000 },
    backoffMultiplier: { min: 1, max: 10 },
} as const;

const RETRY_POLICY_FIELDS: RetryPolicyField[] = ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'backoffMultiplier'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateRetryPolicy(policy: unknown): WebhookRetryPolicy {
    if (policy === undefined || policy === null) {
        throw new WebhookValidationError('retryPolicy must be an object when provided.');
    }

    if (!isPlainObject(policy)) {
        throw new WebhookValidationError('retryPolicy must be an object.');
    }

    for (const field of Object.keys(policy)) {
        if (!RETRY_POLICY_FIELDS.includes(field as RetryPolicyField)) {
            throw new WebhookValidationError(`retryPolicy.${field} is not supported.`);
        }
    }

    if (!RETRY_POLICY_FIELDS.some((field) => field in policy)) {
        throw new WebhookValidationError('retryPolicy must include at least one override field.');
    }

    const maxAttempts = policy.maxAttempts;
    if (maxAttempts !== undefined && (!isPositiveInteger(maxAttempts) || maxAttempts < RETRY_POLICY_LIMITS.maxAttempts.min || maxAttempts > RETRY_POLICY_LIMITS.maxAttempts.max)) {
        throw new WebhookValidationError(
            `retryPolicy.maxAttempts must be an integer between ${RETRY_POLICY_LIMITS.maxAttempts.min} and ${RETRY_POLICY_LIMITS.maxAttempts.max}.`
        );
    }

    const baseDelayMs = policy.baseDelayMs;
    if (baseDelayMs !== undefined && (!isPositiveInteger(baseDelayMs) || baseDelayMs < RETRY_POLICY_LIMITS.baseDelayMs.min || baseDelayMs > RETRY_POLICY_LIMITS.baseDelayMs.max)) {
        throw new WebhookValidationError(
            `retryPolicy.baseDelayMs must be an integer between ${RETRY_POLICY_LIMITS.baseDelayMs.min} and ${RETRY_POLICY_LIMITS.baseDelayMs.max}.`
        );
    }

    const maxDelayMs = policy.maxDelayMs;
    if (maxDelayMs !== undefined && (!isPositiveInteger(maxDelayMs) || maxDelayMs < RETRY_POLICY_LIMITS.maxDelayMs.min || maxDelayMs > RETRY_POLICY_LIMITS.maxDelayMs.max)) {
        throw new WebhookValidationError(
            `retryPolicy.maxDelayMs must be an integer between ${RETRY_POLICY_LIMITS.maxDelayMs.min} and ${RETRY_POLICY_LIMITS.maxDelayMs.max}.`
        );
    }

    if (maxDelayMs !== undefined && baseDelayMs !== undefined && maxDelayMs < baseDelayMs) {
        throw new WebhookValidationError('retryPolicy.maxDelayMs must be greater than or equal to baseDelayMs.');
    }

    const backoffMultiplier = policy.backoffMultiplier;
    if (backoffMultiplier !== undefined && (!isPositiveFiniteNumber(backoffMultiplier) || backoffMultiplier < RETRY_POLICY_LIMITS.backoffMultiplier.min || backoffMultiplier > RETRY_POLICY_LIMITS.backoffMultiplier.max)) {
        throw new WebhookValidationError(
            `retryPolicy.backoffMultiplier must be a number between ${RETRY_POLICY_LIMITS.backoffMultiplier.min} and ${RETRY_POLICY_LIMITS.backoffMultiplier.max}.`
        );
    }

    return {
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(baseDelayMs !== undefined ? { baseDelayMs } : {}),
        ...(maxDelayMs !== undefined ? { maxDelayMs } : {}),
        ...(backoffMultiplier !== undefined ? { backoffMultiplier } : {}),
    };
}

export async function validateWebhookUrl(rawUrl: string): Promise<void> {
    let parsed: URL;

    // 1. Must be a valid URL
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new WebhookValidationError('Invalid URL format.');
    }

    // 2. Must use HTTPS in production
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && parsed.protocol !== 'https:') {
        throw new WebhookValidationError('Webhook URL must use HTTPS in production.');
    }

    // 3. Resolve hostname to IPs and check for private ranges (SSRF prevention)
    let addresses: string[];
    try {
        const result = await dns.lookup(parsed.hostname, { all: true });
        addresses = result.map((r) => r.address);
    } catch {
        throw new WebhookValidationError('Could not resolve webhook hostname.');
    }

    if (isProduction) {
        for (const ip of addresses) {
        if (ipRangeCheck(ip, BLOCKED_RANGES)) {
            throw new WebhookValidationError(
            `Webhook URL resolves to a private/internal IP address (${ip}), which is not allowed.`
            );
        }
        }
    }

    // 4. Block non-standard ports in production
    if (isProduction && parsed.port && !['80', '443'].includes(parsed.port)) {
        throw new WebhookValidationError('Only ports 80 and 443 are allowed in production.');
    }
    }
