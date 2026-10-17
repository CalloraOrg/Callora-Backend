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
        trustProxy: 1,
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
        trustProxy: 1,
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
        allowedRanges: ['127.0.0.1', '::1', '::ffff*127.0.0.1'],
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

  describe('Spoofing Resistance — trusted proxy hops', () => {
    /**
     * With a trusted hop count, the client IP is selected NPositions from the
     * right of X-Forwarded-For. The leftmost entries are client-controlled and
     * MUST not be trusted.
     */

    it('with one trusted hop, uses the rightmost XFF-entry', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2.2.2.2/32'],
        trustProxy: 1,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Leftmost (1.1.1.1) is spoofed; the trusted proxy appended 2.2.2.2
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('spoofed leftmost entry cannot satisfy the allowlist', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: 1,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Attacker spoofs an allowed leftmost IP; trusted proxy appended 10.0.0.1
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100, 10.0.0.1')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('with two trusted hops, selects the second entry from the right', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['2.2.2.2/32'],
        trustProxy: 2,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Rightmost is the closest proxy (3.3.3.3); 2.2.2.2 is the client
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2, 3.3.3.3')
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('blocks when the selected hop is not in allowlist', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: 1,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Selected hop (10.0.0.1) is blocked, even though a leftmost hop is allowed
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100, 10.0.0.1')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });

    it('falls back to socket address when fewer hops than trusted', async () => {
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: 2,
        enabled: true,
      });

      testApp.get('/test', middleware, (req, res) => res.json({ success: true }));

      // Only one hop present but two trusted — fall back to socket IP (127.0.0.1)
      const response = await request(testApp)
        .get('/test')
        .set('X-Forwarded-For', '192.168.1.100')
        .expect(403);

      expect(response.body.code).toBe('IP_NOT_ALLOWED');
    });
  });

  describe('Invalid IP format handling', () => {
    it('falls back to socket IP when proxy header has invalid format (trusted hops)', async () => {
      // When a trusted hop is configured and the header value is not a valid IP,
      // getClientIp falls back to the socket address.
      // The socket IP (127.0.0.1 from supertest) is not in the allowlist → 403.
      const middleware = createIpAllowlist({
        allowedRanges: ['192.168.1.0/24'],
        trustProxy: 1,
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
        trustProxy: 1,
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
});
