import dns from 'dns/promises';
import {
    validateWebhookUrl,
    WebhookValidationError,
    BLOCKED_RANGES,
} from './webhook.validator.js';

describe('webhook.validator module', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalEnv = process.env.NODE_ENV;
        delete process.env.WEBHOOK_ENFORCE_PRIVATE_IP_CHECK;
    });

    afterEach(() => {
        process.env.NODE_ENV = originalEnv;
        delete process.env.WEBHOOK_ENFORCE_PRIVATE_IP_CHECK;
        jest.restoreAllMocks();
    });

    it('exists and is importable', async () => {
        const mod = await import('./webhook.validator.js');
        expect(mod).toBeDefined();
        expect(typeof mod.validateWebhookUrl).toBe('function');
        expect(Array.isArray(BLOCKED_RANGES)).toBe(true);
    });

    it('rejects invalid URL strings', async () => {
        await expect(validateWebhookUrl('not-a-valid-url')).rejects.toThrow(
            WebhookValidationError
        );
        await expect(validateWebhookUrl('not-a-valid-url')).rejects.toThrow(
            'Invalid URL format.'
        );
    });

    it('rejects unsupported protocols (e.g. ftp, file, gopher)', async () => {
        await expect(validateWebhookUrl('ftp://example.com/hook')).rejects.toThrow(
            'Webhook URL must use HTTP or HTTPS protocol.'
        );
        await expect(validateWebhookUrl('file:///etc/passwd')).rejects.toThrow(
            'Webhook URL must use HTTP or HTTPS protocol.'
        );
    });

    it('requires HTTPS in production', async () => {
        process.env.NODE_ENV = 'production';
        await expect(validateWebhookUrl('http://example.com/webhook')).rejects.toThrow(
            'Webhook URL must use HTTPS in production.'
        );
    });

    it('rejects non-standard ports in production', async () => {
        process.env.NODE_ENV = 'production';
        jest.spyOn(dns, 'lookup').mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
        ] as any);

        await expect(
            validateWebhookUrl('https://example.com:8443/webhook')
        ).rejects.toThrow('Only ports 80 and 443 are allowed in production.');
    });

    it('throws when hostname fails DNS resolution', async () => {
        jest.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
        await expect(
            validateWebhookUrl('https://unresolvable.invalid/webhook')
        ).rejects.toThrow('Could not resolve webhook hostname.');
    });

    describe('SSRF / Private IP blocking', () => {
        const privateIps = [
            '10.0.0.1',
            '172.16.0.1',
            '172.31.255.254',
            '192.168.1.1',
            '127.0.0.1',
            '169.254.169.254',
            '100.64.0.1',
            '::1',
            'fc00::1',
        ];

        it.each(privateIps)('rejects private IP %s in production', async (ip) => {
            process.env.NODE_ENV = 'production';
            jest.spyOn(dns, 'lookup').mockResolvedValue([
                { address: ip, family: ip.includes(':') ? 6 : 4 },
            ] as any);

            await expect(
                validateWebhookUrl('https://receiver.example.com/webhook')
            ).rejects.toThrow(`Webhook URL resolves to a private/internal IP address (${ip}), which is not allowed.`);
        });

        it('rejects private IPs when enforcePrivateIpCheck option is passed even in non-production', async () => {
            process.env.NODE_ENV = 'development';
            jest.spyOn(dns, 'lookup').mockResolvedValue([
                { address: '169.254.169.254', family: 4 },
            ] as any);

            await expect(
                validateWebhookUrl('http://receiver.example.com/webhook', {
                    enforcePrivateIpCheck: true,
                })
            ).rejects.toThrow('resolves to a private/internal IP address (169.254.169.254)');
        });

        it('allows public IP address in production', async () => {
            process.env.NODE_ENV = 'production';
            jest.spyOn(dns, 'lookup').mockResolvedValue([
                { address: '93.184.216.34', family: 4 },
            ] as any);

            await expect(
                validateWebhookUrl('https://public-receiver.example.com/webhook')
            ).resolves.toBeUndefined();
        });
    });
});
