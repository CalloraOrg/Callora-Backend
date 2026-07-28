import request from 'supertest';
import express from 'express';
import { createIpAllowlist, createAdminIpAllowlist, createGatewayIpAllowlist } from '../middleware/ipAllowlist.js';
import { logger } from '../middleware/logging.js';

// Mock the logger to avoid actual logging during tests
jest.mock('../middleware/logging.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
}));
const mockLogger = logger as jest.Mocked<typeof logger>;

describe('IP Allowlist Middleware', () => {
  let testApp: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    testApp = express();
    testApp.use(express.json());
  });

  describe('Basic IP Allowlist Functionality', () => {
    it('should allow requests from allowed IP ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24', '10.0.0.1'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ clientIp: '192.168.1.100' }),
        'IP allowlist check passed',
      );
    });

    it('should block requests from non-allowed IP ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.100')
        .expect(403);

      expect(response.body.error).toBe('Forbidden: IP address not allowed');
      expect(response.body.code).toBe('IP_NOT_ALLOWED');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ clientIp: '10.0.0.100' }),
        'IP allowlist blocked request',
      );
    });

    it('should allow all requests when allowlist is disabled', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: false,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.100')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should throw when allowedRanges is empty', () => {
      expect(() => {
        createIpAllowlist({ allowedRanges: [], enabled: true });
      }).toThrow('IP allowlist must have at least one allowed range');
    });
  });

  describe('Spoofing Resistance — trustProxy: false', () => {
    /**
     * When trustProxy is false, forwarded headers MUST be ignored entirely.
     * An attacker cannot bypass the allowlist by injecting X-Forwarded-For,
     * X-Real-IP, CF-Connecting-IP, or any other proxy header.
     */

    it('ignores X-Forwarded-For when trustProxy is false and blocks by socket IP', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: false, // default — never trust headers
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Attacker sends an allowed IP in the header, but socket IP is not allowed.
      // The middleware must use the socket IP (127.0.0.1 from supertest) and block.
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100') // spoofed — must be ignored
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('ignores X-Real-IP spoof when trustProxy is false', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: false,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      const response = await request(testApp)
        .get('/test')
        .set('X-Real-IP', '192.168.1.50') // spoofed — must be ignored
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('ignores CF-Connecting-IP spoof when trustProxy is false', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: false,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      const response = await request(testApp)
        .get('/test')
        .set('CF-Connecting-IP', '192.168.1.50') // spoofed — must be ignored
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('ignores all known proxy headers simultaneously when trustProxy is false', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['10.0.0.0/8'],
        trustProxy: false,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // All headers claim an allowed IP — none should be trusted
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.1')
        .set('X-Real-IP', '10.0.0.2')
        .set('X-Client-IP', '10.0.0.3')
        .set('CF-Connecting-IP', '10.0.0.4')
        .set('X-AWS-Client-IP', '10.0.0.5')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('allows request when socket IP is in allowlist regardless of spoofed headers', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
        trustProxy: false,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Socket IP is 127.0.0.1 (supertest), spoofed header claims a blocked IP
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '1.2.3.4') // spoofed — must be ignored
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Spoofing Resistance — trustProxy: true (leftmost-IP rule)', () => {
    it('uses only the leftmost IP from X-Forwarded-For (client origin)', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Leftmost = client IP (192.168.1.100, allowed)
      // Subsequent entries are proxy hops and must not override the client IP
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100, 10.0.0.1, 172.16.0.1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('blocks when leftmost X-Forwarded-For IP is not in allowlist', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Leftmost = 10.0.0.1 (blocked), even though a later hop is in the allowed range
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.1, 192.168.1.100')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });
  });

  describe('Invalid IP format handling', () => {
    it('falls back to socket IP when proxy header has invalid format (trustProxy: true)', async () => {
      // When trustProxy is true and the header value is not a valid IP,
      // getClientIp falls back to req.ip (socket address).
      // The socket IP (127.0.0.1 from supertest) is not in the allowlist → 403.
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', 'not-an-ip-address')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('returns 400 when the resolved IP is empty (no socket address and no valid header)', async () => {
      // Test the 400 path by mocking getClientIp to return an empty string.
      // This covers the edge case where neither the socket nor any proxy header
      // provides a valid IP (e.g., Unix socket connections).
      const spy = jest.spyOn(await import('../lib/clientIp.js'), 'getClientIp').mockReturnValueOnce('');

      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: false,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      const response = await request(testApp).get('/test').expect(400);
      expect(response.body.code).toBe('INVALID_IP_FORMAT');

      spy.mockRestore();
    });

    it('falls back to socket IP when X-Forwarded-For has empty comma-separated entries', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // ', ,' splits to ['', ' ', ''] — all invalid, so falls back to socket IP → 403
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', ', ,')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });
  });

  describe('IPv6 Support', () => {
    it('allows IPv6 addresses in allowed ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32', '::1'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db8::1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('blocks IPv6 addresses not in allowed ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db9::1')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });
  });

  describe('CIDR boundary tests', () => {
    it('handles /32 CIDR (single IP)', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.100/32'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.100').expect(200);
      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.101').expect(403);
    });

    it('handles /24 CIDR boundaries', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.0').expect(200);
      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.255').expect(200);
      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.0.255').expect(403);
      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.2.0').expect(403);
    });
  });

  describe('Proxy header priority', () => {
    it('checks proxy headers in configured priority order', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        proxyHeaders: ['x-custom-ip', 'x-forwarded-for'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // x-custom-ip (first in priority) wins over x-forwarded-for
      const response = await request(testApp)
        .get('/test')
        .set('X-Custom-Ip', '192.168.1.100')
        .set('X-Forwarded-For', '10.0.0.1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Security logging', () => {
    it('logs configuration on creation (pino-style: obj first, message second)', () => {
      createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          allowedRangesCount: 1,
          trustProxy: true,
          proxyHeaders: expect.any(Array),
          enabled: true,
        },
        'IP allowlist middleware configured',
      );
    });

    it('logs blocked requests with security context', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.100')
        .set('User-Agent', 'test-agent')
        .expect(403);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          clientIp: '10.0.0.100',
          path: '/test',
          method: 'GET',
          userAgent: 'test-agent',
          timestamp: expect.any(String),
        },
        'IP allowlist blocked request',
      );
    });

    it('logs successful allowlist checks', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          clientIp: '192.168.1.100',
          path: '/test',
          method: 'GET',
        },
        'IP allowlist check passed',
      );
    });
  });

  describe('Environment-based configuration', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('creates admin IP allowlist from environment variables', () => {
      process.env.ADMIN_IP_ALLOWED_RANGES = '192.168.1.0/24,10.0.0.1';
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.ADMIN_IP_ALLOWLIST_ENABLED = 'true';

      const middleware = createAdminIpAllowlist();

      expect(middleware).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(Object),
        'IP allowlist middleware configured',
      );
    });

    it('creates gateway IP allowlist from environment variables', () => {
      process.env.GATEWAY_IP_ALLOWED_RANGES = '203.0.113.0/24,198.51.100.0/24';
      process.env.TRUST_PROXY_HEADERS = 'false';
      process.env.GATEWAY_IP_ALLOWLIST_ENABLED = 'true';

      const middleware = createGatewayIpAllowlist();

      expect(middleware).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.any(Object),
        'IP allowlist middleware configured',
      );
    });

    it('warns and allows all IPs when env ranges are empty', () => {
      delete process.env.ADMIN_IP_ALLOWED_RANGES;
      delete process.env.GATEWAY_IP_ALLOWED_RANGES;

      createAdminIpAllowlist();
      createGatewayIpAllowlist();

      expect(mockLogger.warn).toHaveBeenCalledWith('Admin IP allowlist is empty - allowing all IPs');
      expect(mockLogger.warn).toHaveBeenCalledWith('Gateway IP allowlist is empty - allowing all IPs');
    });
  });

  describe('Multiple IP ranges', () => {
    it('allows IPs from any of the specified ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24', '10.0.0.0/8', '203.0.113.100'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      await request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.50').expect(200);
      await request(testApp).get('/test').set('X-Forwarded-For', '10.100.200.50').expect(200);
      await request(testApp).get('/test').set('X-Forwarded-For', '203.0.113.100').expect(200);
      await request(testApp).get('/test').set('X-Forwarded-For', '172.16.0.1').expect(403);
    });
  });
});
