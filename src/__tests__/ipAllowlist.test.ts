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
    // Clear all mock calls
    jest.clearAllMocks();
    
    testApp = express();
    testApp.use(express.json());
  });

  describe('Basic IP Allowlist Functionality', () => {
    it('should allow requests from allowed IP ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24', '10.0.0.1'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Test with IP in allowed range
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith('IP allowlist check passed', expect.any(Object));
    });

    it('should block requests from non-allowed IP ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
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
      expect(mockLogger.warn).toHaveBeenCalledWith('IP allowlist blocked request', expect.any(Object));
    });

    it('should allow all requests when allowlist is disabled', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: false,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow even blocked IP
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.100')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should handle empty allowed ranges configuration', () => {
      expect(() => {
        createIpAllowlist({
          allowedRanges: [],
          enabled: true,
        });
      }).toThrow('IP allowlist must have at least one allowed range');
    });
  });

  describe('IPv6 Support', () => {
    it('should allow IPv6 addresses in allowed ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32', '::1'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Test with IPv6 address in allowed range
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db8::1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should block IPv6 addresses not in allowed ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db9::1')
        .expect(403);

      expect(response.body.error).toBe('Forbidden: IP address not allowed');
      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('should handle IPv6 loopback address', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['::1'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '::1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Boundary CIDR Tests', () => {
    it('should correctly handle /32 CIDR (single IP)', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.100/32'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow exact IP
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      // Should block nearby IP
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.101')
        .expect(403);
    });

    it('should correctly handle /24 CIDR boundaries', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow IPs at boundaries
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.0')
        .expect(200);

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.255')
        .expect(200);

      // Should block IPs outside boundaries
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.0.255')
        .expect(403);

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.2.0')
        .expect(403);
    });

    it('should correctly handle /8 CIDR boundaries', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['10.0.0.0/8'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow IPs at boundaries
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.0')
        .expect(200);

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.255.255.255')
        .expect(200);

      // Should block IPs outside boundaries
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '9.255.255.255')
        .expect(403);

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '11.0.0.0')
        .expect(403);
    });

    it('should handle IPv6 CIDR boundaries', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow IPs at boundaries
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db8::')
        .expect(200);

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff')
        .expect(200);

      // Should block IPs outside boundaries
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db7::')
        .expect(403);

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db9::')
        .expect(403);
    });
  });

  describe('Proxy Header Handling', () => {
    it('should use X-Forwarded-For header when trustProxy is true', async () => {
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
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should handle X-Forwarded-For with multiple IPs (use first IP)', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should use first IP (client) even if second IP is blocked
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100, 10.0.0.1, 172.16.0.1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should check proxy headers in priority order', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        proxyHeaders: ['x-custom-ip', 'x-forwarded-for'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should use x-custom-ip (first in priority) even if x-forwarded-for has different IP
      const response = await request(testApp)
        .get('/test')
        .set('X-Custom-Ip', '192.168.1.100')
        .set('X-Forwarded-For', '10.0.0.1')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should fallback to direct IP when proxy headers are invalid', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Mock req.ip to return localhost
      testApp.use((req, res, next) => {
        (req as any).ip = '127.0.0.1';
        next();
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', 'invalid-ip-format')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should not use proxy headers when trustProxy is false', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'],
        trustProxy: false,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Mock req.ip to return localhost
      testApp.use((req, res, next) => {
        (req as any).ip = '127.0.0.1';
        next();
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.1') // This should be ignored
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Spoofing Resistance', () => {
    it('should reject invalid IP formats', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', 'not-an-ip-address')
        .expect(400);

      expect(response.body.error).toBe('Bad Request: invalid client IP format');
      expect(response.body.code).toBe('INVALID_IP_FORMAT');
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid IP format detected', expect.any(Object));
    });

    it('should handle empty proxy header values', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Mock req.ip to return localhost
      testApp.use((req, res, next) => {
        (req as any).ip = '127.0.0.1';
        next();
      });

      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should handle malformed X-Forwarded-For with empty IPs', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should handle and reject malformed header
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', ', ,')
        .expect(400);

      expect(response.body.error).toBe('Bad Request: invalid client IP format');
    });
  });

  describe('Security Logging', () => {
    it('should log configuration on creation', () => {
      createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: true,
        enabled: true,
      });

      expect(mockLogger.info).toHaveBeenCalledWith('IP allowlist middleware configured', {
        allowedRangesCount: 1,
        trustProxy: true,
        proxyHeaders: expect.any(Array),
        enabled: true,
      });
    });

    it('should log blocked requests with security context', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.0.0.100')
        .set('User-Agent', 'test-agent')
        .expect(403);

      expect(mockLogger.warn).toHaveBeenCalledWith('IP allowlist blocked request', {
        clientIp: '10.0.0.100',
        path: '/test',
        method: 'GET',
        userAgent: 'test-agent',
        timestamp: expect.any(String),
      });
    });

    it('should log successful allowlist checks', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(mockLogger.debug).toHaveBeenCalledWith('IP allowlist check passed', {
        clientIp: '192.168.1.100',
        path: '/test',
        method: 'GET',
      });
    });
  });

  describe('Environment-based Configuration', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should create admin IP allowlist from environment variables', () => {
      process.env.ADMIN_IP_ALLOWED_RANGES = '192.168.1.0/24,10.0.0.1';
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.ADMIN_IP_ALLOWLIST_ENABLED = 'true';

      const middleware = createAdminIpAllowlist();
      
      expect(middleware).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('IP allowlist middleware configured', expect.any(Object));
    });

    it('should create gateway IP allowlist from environment variables', () => {
      process.env.GATEWAY_IP_ALLOWED_RANGES = '203.0.113.0/24,198.51.100.0/24';
      process.env.TRUST_PROXY_HEADERS = 'false';
      process.env.GATEWAY_IP_ALLOWLIST_ENABLED = 'true';

      const middleware = createGatewayIpAllowlist();
      
      expect(middleware).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('IP allowlist middleware configured', expect.any(Object));
    });

    it('should handle empty environment variables gracefully', () => {
      // Clear relevant environment variables
      delete process.env.ADMIN_IP_ALLOWED_RANGES;
      delete process.env.GATEWAY_IP_ALLOWED_RANGES;

      const adminMiddleware = createAdminIpAllowlist();
      const gatewayMiddleware = createGatewayIpAllowlist();
      
      expect(adminMiddleware).toBeDefined();
      expect(gatewayMiddleware).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith('Admin IP allowlist is empty - allowing all IPs');
      expect(mockLogger.warn).toHaveBeenCalledWith('Gateway IP allowlist is empty - allowing all IPs');
    });
  });

  describe('Multiple IP Ranges', () => {
    it('should allow IPs from any of the specified ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24', '10.0.0.0/8', '203.0.113.100'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow IP from first range
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.50')
        .expect(200);

      // Should allow IP from second range
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '10.100.200.50')
        .expect(200);

      // Should allow exact IP match
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '203.0.113.100')
        .expect(200);

      // Should block IP not in any range
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '172.16.0.1')
        .expect(403);
    });

    it('should handle mixed IPv4 and IPv6 ranges', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24', '2001:db8::/32'],
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Should allow IPv4
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      // Should allow IPv6
      await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db8::1')
        .expect(200);
    });
  });
});
