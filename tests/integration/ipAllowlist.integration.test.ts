import request from 'supertest';
import { app } from '../../src/index.js';
import { createIpAllowlist } from '../../src/middleware/ipAllowlist.js';
import express from 'express';

describe('IP Allowlist Integration Tests', () => {
  let testApp: express.Application;

  beforeEach(() => {
    testApp = express();
    testApp.use(express.json());
  });

  describe('Admin Endpoint Protection', () => {
    it('should block unauthorized IP access to admin endpoints', async () => {
      // Create a test admin endpoint with strict IP allowlist
      const adminMiddleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'], // Only allow localhost
        enabled: true,
        trustProxy: false,
      });

      testApp.get('/admin/test', adminMiddleware, (req, res) => {
        res.json({ message: 'Admin access granted' });
      });

      // Should block non-localhost IP
      const response = await request(testApp)
        .get('/admin/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(403);

      expect(response.body.error).toBe('Forbidden: IP address not allowed');
      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('should allow authorized IP access to admin endpoints', async () => {
      const adminMiddleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1', '192.168.1.0/24'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/admin/test', adminMiddleware, (req, res) => {
        res.json({ message: 'Admin access granted' });
      });

      // Should allow authorized IP
      const response = await request(testApp)
        .get('/admin/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(response.body.message).toBe('Admin access granted');
    });
  });

  describe('Gateway Endpoint Protection', () => {
    it('should block unauthorized IP access to gateway endpoints', async () => {
      const gatewayMiddleware = createIpAllowlist({
        allowedRanges: ['203.0.113.0/24'], // Test network range
        enabled: true,
        trustProxy: true,
      });

      testApp.post('/gateway/test', gatewayMiddleware, (req, res) => {
        res.json({ message: 'Gateway access granted' });
      });

      // Should block IP outside allowed range
      const response = await request(testApp)
        .post('/gateway/test')
        .set('X-Forwarded-For', '198.51.100.100')
        .send({ data: 'test' })
        .expect(403);

      expect(response.body.error).toBe('Forbidden: IP address not allowed');
    });

    it('should allow authorized IP access to gateway endpoints', async () => {
      const gatewayMiddleware = createIpAllowlist({
        allowedRanges: ['203.0.113.0/24', '198.51.100.0/24'],
        enabled: true,
        trustProxy: true,
      });

      testApp.post('/gateway/test', gatewayMiddleware, (req, res) => {
        res.json({ message: 'Gateway access granted', received: req.body });
      });

      // Should allow IP from first range
      const response1 = await request(testApp)
        .post('/gateway/test')
        .set('X-Forwarded-For', '203.0.113.100')
        .send({ data: 'test1' })
        .expect(200);

      expect(response1.body.message).toBe('Gateway access granted');
      expect(response1.body.received.data).toBe('test1');

      // Should allow IP from second range
      const response2 = await request(testApp)
        .post('/gateway/test')
        .set('X-Forwarded-For', '198.51.100.200')
        .send({ data: 'test2' })
        .expect(200);

      expect(response2.body.message).toBe('Gateway access granted');
      expect(response2.body.received.data).toBe('test2');
    });
  });

  describe('Proxy Header Integration', () => {
    it('should handle multiple proxy headers correctly', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
        trustProxy: true,
        proxyHeaders: ['x-custom-ip', 'x-forwarded-for'],
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ clientIp: req.ip });
      });

      // Should use x-custom-ip (higher priority) even if x-forwarded-for has different IP
      const response = await request(testApp)
        .get('/test')
        .set('X-Custom-Ip', '192.168.1.100')
        .set('X-Forwarded-For', '10.0.0.1')
        .expect(200);

      expect(response.body.clientIp).toBeDefined();
    });

    it('should fallback to direct IP when proxy headers are invalid', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ success: true });
      });

      // Mock req.ip to be localhost
      testApp.use((req, res, next) => {
        (req as any).ip = '127.0.0.1';
        next();
      });

      // Should fallback to direct IP when proxy header is invalid
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', 'invalid-ip-format')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('IPv6 Integration', () => {
    it('should handle IPv6 addresses in production-like scenarios', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32', '::1'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ message: 'IPv6 access granted' });
      });

      // Should allow IPv6 address
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db8::1')
        .expect(200);

      expect(response.body.message).toBe('IPv6 access granted');
    });

    it('should block IPv6 addresses not in allowlist', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2001:db8::/32'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ message: 'IPv6 access granted' });
      });

      // Should block IPv6 address outside allowed range
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '2001:db9::1')
        .expect(403);

      expect(response.body.error).toBe('Forbidden: IP address not allowed');
    });
  });

  describe('Security Logging Integration', () => {
    it('should log security events in integration context', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/secure', middleware, (req, res) => {
        res.json({ message: 'Access granted' });
      });

      // Mock logger to capture logs
      const mockLogs: any[] = [];
      const originalWarn = console.warn;
      console.warn = (message: string, data: any) => {
        mockLogs.push({ message, data });
      };

      try {
        // Trigger a block event
        await request(testApp)
          .get('/secure')
          .set('X-Forwarded-For', '192.168.1.100')
          .set('User-Agent', 'test-integration-agent')
          .expect(403);

        // Verify security log was created
        const securityLog = mockLogs.find(log => 
          log.message === 'IP allowlist blocked request'
        );

        expect(securityLog).toBeDefined();
        expect(securityLog.data.clientIp).toBe('192.168.1.100');
        expect(securityLog.data.path).toBe('/secure');
        expect(securityLog.data.method).toBe('GET');
        expect(securityLog.data.userAgent).toBe('test-integration-agent');
        expect(securityLog.data.timestamp).toBeDefined();

      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('Performance and Load Testing', () => {
    it('should handle multiple concurrent requests efficiently', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ message: 'Access granted' });
      });

      // Create multiple concurrent requests
      const requests = Array.from({ length: 10 }, (_, i) =>
        request(testApp)
          .get('/test')
          .set('X-Forwarded-For', `192.168.1.${100 + i}`)
      );

      // All should succeed
      const responses = await Promise.all(requests);
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('Access granted');
      });
    });

    it('should handle mixed allow/block scenarios efficiently', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ message: 'Access granted' });
      });

      // Create mixed requests (some allowed, some blocked)
      const requests = [
        request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.100'), // allowed
        request(testApp).get('/test').set('X-Forwarded-For', '10.0.0.1'), // blocked
        request(testApp).get('/test').set('X-Forwarded-For', '192.168.1.200'), // allowed
        request(testApp).get('/test').set('X-Forwarded-For', '172.16.0.1'), // blocked
      ];

      const responses = await Promise.allSettled(requests);
      
      // Check that requests were handled correctly
      const fulfilledResponses = responses
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as any).value);

      // Should have 2 successful and 2 blocked responses
      const successCount = fulfilledResponses.filter(r => r.status === 200).length;
      const blockedCount = fulfilledResponses.filter(r => r.status === 403).length;

      expect(successCount).toBe(2);
      expect(blockedCount).toBe(2);
    });
  });

  describe('Environment Configuration Integration', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should integrate with environment-based admin configuration', async () => {
      process.env.ADMIN_IP_ALLOWED_RANGES = '192.168.1.0/24,10.0.0.1';
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.ADMIN_IP_ALLOWLIST_ENABLED = 'true';

      // Import after setting environment variables
      const { createAdminIpAllowlist } = await import('../../src/middleware/ipAllowlist.js');
      const adminMiddleware = createAdminIpAllowlist();

      testApp.get('/admin/test', adminMiddleware, (req, res) => {
        res.json({ message: 'Admin access granted' });
      });

      // Should allow IP from configured range
      const response = await request(testApp)
        .get('/admin/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(200);

      expect(response.body.message).toBe('Admin access granted');
    });

    it('should integrate with environment-based gateway configuration', async () => {
      process.env.GATEWAY_IP_ALLOWED_RANGES = '203.0.113.0/24,198.51.100.0/24';
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.GATEWAY_IP_ALLOWLIST_ENABLED = 'true';

      const { createGatewayIpAllowlist } = await import('../../src/middleware/ipAllowlist.js');
      const gatewayMiddleware = createGatewayIpAllowlist();

      testApp.post('/gateway/test', gatewayMiddleware, (req, res) => {
        res.json({ message: 'Gateway access granted' });
      });

      // Should allow IP from configured range
      const response = await request(testApp)
        .post('/gateway/test')
        .set('X-Forwarded-For', '203.0.113.100')
        .send({ data: 'test' })
        .expect(200);

      expect(response.body.message).toBe('Gateway access granted');
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle malformed IP headers gracefully', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['127.0.0.1'],
        enabled: true,
        trustProxy: true,
      });

      testApp.get('/test', middleware, (req, res) => {
        res.json({ message: 'Access granted' });
      });

      // Mock req.ip to be localhost for fallback
      testApp.use((req, res, next) => {
        (req as any).ip = '127.0.0.1';
        next();
      });

      // Should handle various malformed headers gracefully
      const malformedHeaders = [
        '',
        '   ',
        'not-an-ip',
        '999.999.999.999',
        '192.168.1',
        '192.168.1.1.1',
      ];

      for (const header of malformedHeaders) {
        const response = await request(testApp)
          .get('/test')
          .set('X-Forwarded-For', header)
          .expect(400);

        expect(response.body.error).toBe('Bad Request: invalid client IP format');
        expect(response.body.code).toBe('INVALID_IP_FORMAT');
      }
    });

    it('should handle empty allowlist configuration', async () => {
      // This should throw during creation, not during request
      expect(() => {
        createIpAllowlist({
          allowedRanges: [],
          enabled: true,
        });
      }).toThrow('IP allowlist must have at least one allowed range');
    });
  });
});
