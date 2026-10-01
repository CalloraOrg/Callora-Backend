import {
  validateUpstreamBaseUrl,
  validateResolvedUpstreamTarget,
  buildUpstreamTargetUrl,
  parseUpstreamHostAllowlist,
  DEFAULT_UPSTREAM_HOST_ALLOWLIST,
} from '../upstreamTarget';
import dns from 'node:dns/promises';

jest.mock('node:dns/promises');

describe('upstreamTarget', () => {
  describe('parseUpstreamHostAllowlist', () => {
    it('returns default allowlist when empty or undefined', () => {
      expect(parseUpstreamHostAllowlist('')).toEqual([...DEFAULT_UPSTREAM_HOST_ALLOWLIST]);
      expect(parseUpstreamHostAllowlist(undefined)).toEqual([...DEFAULT_UPSTREAM_HOST_ALLOWLIST]);
    });

    it('parses comma-separated list and removes trailing dots', () => {
      expect(parseUpstreamHostAllowlist('example.com,*.example.com.')).toEqual([
        'example.com',
        '*.example.com',
      ]);
    });

    it('deduplicates entries', () => {
      expect(parseUpstreamHostAllowlist('example.com,example.com')).toEqual(['example.com']);
    });
  });

  describe('validateUpstreamBaseUrl', () => {
    const cases = [
      { url: 'ftp://example.com', error: 'base_url must use http or https.' },
      { url: 'https:///foo', error: 'base_url must include a hostname.' },
      { url: 'https://user:pass@example.com', error: 'base_url must not include embedded credentials.' },
      { url: 'https://example.com?foo=bar', error: 'base_url must not include query strings or fragments.' },
      { url: 'https://example.com#frag', error: 'base_url must not include query strings or fragments.' },
      { url: 'https://badexample.com', opts: { allowedHosts: ['*.example.com'] }, error: 'is not in the configured upstream allowlist' },
      { url: 'http://127.0.0.1', opts: { allowedHosts: ['*'] }, error: 'resolves to a private or loopback IP range' },
      { url: 'http://[::1]', opts: { allowedHosts: ['*'] }, error: 'resolves to a private or loopback IP range' },
      { url: 'http://10.0.0.1', opts: { allowedHosts: ['*'] }, error: 'resolves to a private or loopback IP range' },
      { url: 'http://169.254.169.254', opts: { allowedHosts: ['*'] }, error: 'resolves to a private or loopback IP range' },
    ];

    test.each(cases)('rejects $url with error $error', ({ url, opts, error }) => {
      expect(() => validateUpstreamBaseUrl(url, opts)).toThrow(error);
    });

    it('allows valid URLs matching allowlist', () => {
      const opts = { allowedHosts: ['example.com', '*.example.com'] };
      expect(validateUpstreamBaseUrl('https://example.com', opts)).toBe('https://example.com');
      expect(validateUpstreamBaseUrl('https://sub.example.com', opts)).toBe('https://sub.example.com');
      // *.example.com matches sub.example.com and example.com
    });

    it('allows private IP literals when explicitly allowed', () => {
      const explicitOpts = { allowedHosts: ['127.0.0.1', '::1', '10.0.0.1', '169.254.169.254'] };
      expect(validateUpstreamBaseUrl('http://127.0.0.1', explicitOpts)).toBe('http://127.0.0.1');
      expect(validateUpstreamBaseUrl('http://[::1]', explicitOpts)).toBe('http://[::1]');
      expect(validateUpstreamBaseUrl('http://10.0.0.1', explicitOpts)).toBe('http://10.0.0.1');
      expect(validateUpstreamBaseUrl('http://169.254.169.254', explicitOpts)).toBe('http://169.254.169.254');
    });
  });

  describe('validateResolvedUpstreamTarget', () => {
    beforeEach(() => {
      jest.resetAllMocks();
    });

    it('skips DNS resolution for IP literals', async () => {
      const opts = { allowedHosts: ['1.1.1.1'] };
      const result = await validateResolvedUpstreamTarget('http://1.1.1.1', opts);
      expect(result).toBe('http://1.1.1.1');
      expect(dns.lookup).not.toHaveBeenCalled();
    });

    it('rejects unresolvable hosts', async () => {
      const opts = { allowedHosts: ['*'] };
      jest.mocked(dns.lookup).mockRejectedValueOnce(new Error('ENOTFOUND'));
      await expect(validateResolvedUpstreamTarget('http://example.com', opts)).rejects.toThrow('could not be resolved');
    });

    it('rejects empty resolution results', async () => {
      const opts = { allowedHosts: ['*'] };
      jest.mocked(dns.lookup).mockResolvedValueOnce([] as any);
      await expect(validateResolvedUpstreamTarget('http://example.com', opts)).rejects.toThrow('did not resolve to an address');
    });

    it('allows public IP resolution', async () => {
      const opts = { allowedHosts: ['*'] };
      jest.mocked(dns.lookup).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as any);
      const result = await validateResolvedUpstreamTarget('http://example.com', opts);
      expect(result).toBe('http://example.com');
    });

    it('rejects DNS results mixing public and private addresses', async () => {
      const opts = { allowedHosts: ['*'] };
      jest.mocked(dns.lookup).mockResolvedValueOnce([
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ] as any);
      await expect(validateResolvedUpstreamTarget('http://example.com', opts)).rejects.toThrow('resolves to a private or loopback IP range');
    });
  });

  describe('buildUpstreamTargetUrl', () => {
    it('appends path correctly', () => {
      expect(buildUpstreamTargetUrl('https://example.com/api', '/users')).toBe('https://example.com/api/users');
      expect(buildUpstreamTargetUrl('https://example.com/api/', 'users')).toBe('https://example.com/api/users');
      expect(buildUpstreamTargetUrl('https://example.com/api/', '/users')).toBe('https://example.com/api/users');
    });

    it('prevents escaping the base path with ../', () => {
      // Test that throwing an error or resolving correctly prevents escape
      // Given the requirement, it should likely throw or encode. We'll test what it actually does first.
      // But we will write the assertion such that it expects it NOT to escape.
      const url = buildUpstreamTargetUrl('https://example.com/api/v1', '../users');
      // If it resolved to https://example.com/api/users, that would be escaping.
      // So we expect it to either throw or NOT equal https://example.com/api/users
      // We will just expect it to not escape, e.g. start with the base path or encoded.
      // If the code is buggy, we'll fix the code next.
      expect(url.startsWith('https://example.com/api/v1')).toBe(true);
    });
  });
});
