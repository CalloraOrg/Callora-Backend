import { URL } from 'url';
import dns from 'dns/promises';
import ipRangeCheck from 'ip-range-check';

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