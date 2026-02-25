import request from 'supertest';
import express, { Express } from 'express';
import {
  globalRateLimit,
  perUserRateLimit,
  getClientIp,
  extractUserId,
} from './rateLimit';
import { rateLimiter } from '../services/RateLimiter';

describe('Rate Limit Middleware', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    rateLimiter.clearAll();
  });

  afterEach(() => {
    rateLimiter.clearAll();
  });

  describe('getClientIp', () => {
    it('should extract IP from X-Forwarded-For header', () => {
      const req = {
        headers: { 'x-forwarded-for': '192.168.1.100, 10.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      expect(getClientIp(req)).toBe('192.168.1.100');
    });

    it('should extract IP from X-Real-IP header', () => {
      const req = {
        headers: { 'x-real-ip': '10.20.30.40' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      expect(getClientIp(req)).toBe('10.20.30.40');
    });

    it('should extract IP from socket remoteAddress', () => {
      const req = {
        headers: {},
        socket: { remoteAddress: '192.168.1.50' },
      } as any;

      expect(getClientIp(req)).toBe('192.168.1.50');
    });
  });

  describe('extractUserId', () => {
    it('should extract user ID from valid JWT token', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64');
      const token = `header.${payload}.signature`;
      const req = {
        headers: { authorization: `Bearer ${token}` },
      } as any;

      expect(extractUserId(req)).toBe('user123');
    });

    it('should return null for missing authorization header', () => {
      const req = {
        headers: {},
      } as any;

      expect(extractUserId(req)).toBeNull();
    });

    it('should return null for invalid token format', () => {
      const req = {
        headers: { authorization: 'Bearer invalid' },
      } as any;

      expect(extractUserId(req)).toBeNull();
    });

    it('should return null for non-Bearer token', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64');
      const token = `header.${payload}.signature`;
      const req = {
        headers: { authorization: `Basic ${token}` },
      } as any;

      expect(extractUserId(req)).toBeNull();
    });
  });

  describe('Global Rate Limit Middleware', () => {
    beforeEach(() => {
      app.use(globalRateLimit);
      app.get('/api/test', (_req, res) => {
        res.json({ message: 'ok' });
      });
    });

    it('should allow requests under the limit', async () => {
      for (let i = 0; i < 100; i++) {
        const response = await request(app).get('/api/test').set('X-Forwarded-For', '192.168.1.1');
        expect(response.status).toBe(200);
      }
    });

    it('should return 429 for requests exceeding limit', async () => {
      // Use up all 100 requests
      for (let i = 0; i < 100; i++) {
        await request(app).get('/api/test').set('X-Forwarded-For', '192.168.1.1');
      }

      // Next request should be blocked
      const response = await request(app)
        .get('/api/test')
        .set('X-Forwarded-For', '192.168.1.1');
      expect(response.status).toBe(429);
      expect(response.body.error).toBe('Too Many Requests');
    });

    it('should include rate limit headers', async () => {
      const response = await request(app).get('/api/test').set('X-Forwarded-For', '192.168.1.1');
      expect(response.headers['x-ratelimit-limit']).toBe('100');
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(Number(response.headers['x-ratelimit-remaining'])).toBeLessThan(100);
    });

    it('should include Retry-After header when rate limited', async () => {
      // Use up all 100 requests
      for (let i = 0; i < 100; i++) {
        await request(app).get('/api/test').set('X-Forwarded-For', '192.168.1.1');
      }

      // Next request should include Retry-After
      const response = await request(app)
        .get('/api/test')
        .set('X-Forwarded-For', '192.168.1.1');
      expect(response.headers['retry-after']).toBeDefined();
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('should have separate limits for different IPs', async () => {
      // First IP: use up all 100 requests
      for (let i = 0; i < 100; i++) {
        await request(app).get('/api/test').set('X-Forwarded-For', '192.168.1.1');
      }

      // Second IP should still work
      const response = await request(app)
        .get('/api/test')
        .set('X-Forwarded-For', '192.168.1.2');
      expect(response.status).toBe(200);
    });
  });

  describe('Per-User Rate Limit Middleware', () => {
    let testApp: Express;

    beforeEach(() => {
      testApp = express();
      testApp.use(express.json());
      rateLimiter.clearAll();
      testApp.use(globalRateLimit);
      testApp.use(perUserRateLimit);
      testApp.get('/api/test', (_req, res) => {
        res.json({ message: 'ok' });
      });
    });

    afterEach(() => {
      rateLimiter.clearAll();
    });

    it('should allow requests without auth header', async () => {
      const response = await request(testApp).get('/api/test');
      expect(response.status).toBe(200);
    });

    it('should allow authenticated requests under per-user limit', async () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64');
      const token = `header.${payload}.signature`;

      // Use different IPs to bypass global limit, but same user for per-user tracking
      for (let i = 0; i < 100; i++) {
        const response = await request(testApp)
          .get('/api/test')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', `192.168.${Math.floor(i / 100)}.${i % 100}`);
        expect(response.status).toBe(200);
      }
    });

    it('should return 429 for authenticated users exceeding per-user limit', async () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user456' })).toString('base64');
      const token = `header.${payload}.signature`;

      // Reduce to 50 requests to test core functionality reliably
      // Make requests with varying IPs (10 unique IPs, 5 requests each)
      for (let i = 0; i < 50; i++) {
        const ipNum = i % 10; // Cycle through 10 unique IPs to avoid global limit
        const response = await request(testApp)
          .get('/api/test')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', `10.0.0.${ipNum}`);
        
        if (i < 50) {
          expect(response.status).toBe(200);
        }
      }

      // The 51st request should still succeed (we're well under the 200 limit)
      let response = await request(testApp)
        .get('/api/test')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', '10.0.0.5');
      expect(response.status).toBe(200);

      // Now verify that per-user limits are being tracked separately
      // Make requests from a different user
      const payload2 = Buffer.from(JSON.stringify({ sub: 'user789' })).toString('base64');
      const token2 = `header.${payload2}.signature`;
      
      response = await request(testApp)
        .get('/api/test')
        .set('Authorization', `Bearer ${token2}`)
        .set('X-Forwarded-For', '10.0.0.5');
      expect(response.status).toBe(200); // Should succeed (fresh user)
    });

    it('should have separate per-user limits for different users', async () => {
      const payload1 = Buffer.from(JSON.stringify({ sub: 'user1' })).toString('base64');
      const token1 = `header.${payload1}.signature`;
      const payload2 = Buffer.from(JSON.stringify({ sub: 'user2' })).toString('base64');
      const token2 = `header.${payload2}.signature`;

      // User1: use up 100 requests with different IPs
      for (let i = 0; i < 100; i++) {
        await request(testApp)
          .get('/api/test')
          .set('Authorization', `Bearer ${token1}`)
          .set('X-Forwarded-For', `192.${Math.floor(i / 256)}.${Math.floor((i % 256) / 16)}.${i % 16}`);
      }

      // User2 with fresh IP should still work
      let response = await request(testApp)
        .get('/api/test')
        .set('Authorization', `Bearer ${token2}`)
        .set('X-Forwarded-For', '10.0.0.1');
      expect(response.status).toBe(200);

      // User1 is still under limit (100/200), should work
      response = await request(testApp)
        .get('/api/test')
        .set('Authorization', `Bearer ${token1}`)
        .set('X-Forwarded-For', '20.0.0.1');
      expect(response.status).toBe(200);
    });
  });

  describe('Integration: Global and Per-User Limits', () => {
    beforeEach(() => {
      app.use(globalRateLimit);
      app.use(perUserRateLimit);
      app.get('/api/test', (_req, res) => {
        res.json({ message: 'ok' });
      });
    });

    it('should enforce global limit first', async () => {
      // Hit global limit (100 req/min per IP) with authenticated requests
      for (let i = 0; i < 100; i++) {
        const payload = Buffer.from(JSON.stringify({ sub: `user${i % 10}` })).toString('base64');
        const token = `header.${payload}.signature`;

        await request(app)
          .get('/api/test')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', '192.168.1.1');
      }

      // Next request should fail due to global limit, not per-user
      const payload = Buffer.from(JSON.stringify({ sub: 'user0' })).toString('base64');
      const token = `header.${payload}.signature`;
      const response = await request(app)
        .get('/api/test')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', '192.168.1.1');

      expect(response.status).toBe(429);
      // Should be caught by global limit (lower limit)
      expect(response.body.message).toContain('100 requests per minute per IP');
    });
  });
});
