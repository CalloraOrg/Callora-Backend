/**
 * Security Headers Integration Tests
 * 
 * Integration tests for production-safe security headers and CORS configuration
 * Tests the actual running server with real HTTP requests
 */

import assert from 'node:assert/strict';
import request from 'supertest';

// Mock better-sqlite3 to prevent native binding errors
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

import { createTestDb } from '../helpers/db.js';
import { createApp } from '../../src/app.js';
import type { HealthCheckConfig } from '../../src/services/healthCheck.js';

describe('Security Headers Integration Tests', () => {
  describe('Production Environment Security Headers', () => {
    let testDb: any;
    
    beforeAll(async () => {
      testDb = createTestDb();
    });

    afterAll(async () => {
      await testDb.end();
    });

    test('applies comprehensive security headers in production', async () => {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
      };

      // Set production environment
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const originalCors = process.env.CORS_ALLOWED_ORIGINS;
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';

      try {
        const app = createApp({ healthCheckConfig: config });
        
        // Test health endpoint
        const response = await request(app)
          .get('/api/health')
          .set('Origin', 'https://app.example.com');

        assert.equal(response.status, 200);
        
        // Verify security headers are present
        assert.ok(response.headers['content-security-policy'], 'CSP header should be present');
        assert.ok(response.headers['x-frame-options'], 'X-Frame-Options header should be present');
        assert.ok(response.headers['x-content-type-options'], 'X-Content-Type-Options header should be present');
        assert.ok(response.headers['referrer-policy'], 'Referrer-Policy header should be present');
        assert.ok(response.headers['strict-transport-security'], 'HSTS header should be present in production');
        
        // Verify CSP content
        const csp = response.headers['content-security-policy'];
        assert.match(csp, /default-src 'self'/, 'CSP should restrict default sources');
        assert.match(csp, /script-src 'self'/, 'CSP should restrict script sources');
        assert.match(csp, /object-src 'none'/, 'CSP should disable objects');
        assert.match(csp, /frame-src 'none'/, 'CSP should disable frames');
        
        // Verify HSTS content
        const hsts = response.headers['strict-transport-security'];
        assert.match(hsts, /max-age=31536000/, 'HSTS should have 1-year max-age');
        assert.match(hsts, /includeSubDomains/, 'HSTS should include subdomains');
        assert.match(hsts, /preload/, 'HSTS should be preloadable');
        
        // Verify other headers
        assert.equal(response.headers['x-frame-options'], 'DENY', 'Should deny framing');
        assert.equal(response.headers['x-content-type-options'], 'nosniff', 'Should prevent MIME sniffing');
        assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Should use strict referrer policy');
        
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.CORS_ALLOWED_ORIGINS = originalCors;
      }
    });

    test('applies CORS headers correctly for allowed origins', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalCors = process.env.CORS_ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';

      try {
        const app = createApp();
        
        const response = await request(app)
          .get('/api/health')
          .set('Origin', 'https://app.example.com');

        assert.equal(response.status, 200);
        assert.equal(response.headers['access-control-allow-origin'], 'https://app.example.com');
        assert.equal(response.headers['access-control-allow-credentials'], 'true');
        
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.CORS_ALLOWED_ORIGINS = originalCors;
      }
    });

    test('blocks CORS for unauthorized origins in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalCors = process.env.CORS_ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

      try {
        const app = createApp();
        
        const response = await request(app)
          .get('/api/health')
          .set('Origin', 'https://malicious.example.com');

        assert.equal(response.status, 500);
        assert.ok(response.body.error?.includes('CORS'), 'Should return CORS error');
        
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.CORS_ALLOWED_ORIGINS = originalCors;
      }
    });

    test('handles preflight requests correctly', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalCors = process.env.CORS_ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

      try {
        const app = createApp();
        
        const response = await request(app)
          .options('/api/health')
          .set('Origin', 'https://app.example.com')
          .set('Access-Control-Request-Method', 'GET')
          .set('Access-Control-Request-Headers', 'Content-Type,Authorization');

        assert.equal(response.status, 204);
        assert.equal(response.headers['access-control-allow-origin'], 'https://app.example.com');
        assert.ok(response.headers['access-control-allow-methods'], 'Should allow methods');
        assert.ok(response.headers['access-control-allow-headers'], 'Should allow headers');
        assert.equal(response.headers['access-control-max-age'], '600', 'Should use 10-minute cache in production');
        
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.CORS_ALLOWED_ORIGINS = originalCors;
      }
    });
  });

  describe('Development Environment Security', () => {
    test('applies relaxed security headers in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        const app = createApp();
        
        const response = await request(app).get('/api/health');

        assert.equal(response.status, 200);
        
        // Should still have basic security headers
        assert.ok(response.headers['content-security-policy'], 'CSP header should be present');
        assert.ok(response.headers['x-frame-options'], 'X-Frame-Options header should be present');
        assert.ok(response.headers['x-content-type-options'], 'X-Content-Type-Options header should be present');
        assert.ok(response.headers['referrer-policy'], 'Referrer-Policy header should be present');
        
        // But should NOT have HSTS in development
        assert.equal(response.headers['strict-transport-security'], undefined, 'HSTS should not be present in development');
        
        // CSP should be more relaxed
        const csp = response.headers['content-security-policy'];
        assert.match(csp, /'unsafe-inline'/, 'CSP should allow unsafe-inline in development');
        
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('allows localhost origins in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalCors = process.env.CORS_ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'development';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'; // Different from localhost

      try {
        const app = createApp();
        
        // Test various localhost ports
        const testCases = [
          { origin: 'http://localhost:3000', expected: 'http://localhost:3000' },
          { origin: 'http://localhost:5173', expected: 'http://localhost:5173' },
          { origin: 'http://localhost:8080', expected: 'http://localhost:8080' },
        ];

        for (const testCase of testCases) {
          const response = await request(app)
            .get('/api/health')
            .set('Origin', testCase.origin);

          assert.equal(response.status, 200, `Should allow ${testCase.origin}`);
          assert.equal(response.headers['access-control-allow-origin'], testCase.expected, `Should reflect ${testCase.origin}`);
        }
        
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.CORS_ALLOWED_ORIGINS = originalCors;
      }
    });

    test('uses longer CORS cache in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalCors = process.env.CORS_ALLOWED_ORIGINS;
      process.env.NODE_ENV = 'development';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

      try {
        const app = createApp();
        
        const response = await request(app)
          .options('/api/health')
          .set('Origin', 'https://app.example.com')
          .set('Access-Control-Request-Method', 'GET');

        assert.equal(response.status, 204);
        assert.equal(response.headers['access-control-max-age'], '86400', 'Should use 24-hour cache in development');
        
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.CORS_ALLOWED_ORIGINS = originalCors;
      }
    });
  });

  describe('Security Header Content Validation', () => {
    test('includes all required CSP directives', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      
      const csp = response.headers['content-security-policy'];
      assert.ok(csp, 'CSP should be present');
      
      // Verify all required directives are present
      assert.match(csp, /default-src 'self'/, 'Should have default-src');
      assert.match(csp, /script-src 'self'/, 'Should have script-src');
      assert.match(csp, /style-src 'self'/, 'Should have style-src');
      assert.match(csp, /img-src 'self' data: https:/, 'Should have img-src');
      assert.match(csp, /connect-src 'self'/, 'Should have connect-src');
      assert.match(csp, /font-src 'self'/, 'Should have font-src');
      assert.match(csp, /object-src 'none'/, 'Should have object-src');
      assert.match(csp, /media-src 'self'/, 'Should have media-src');
      assert.match(csp, /frame-src 'none'/, 'Should have frame-src');
    });

    test('prevents information disclosure', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      
      // Should not expose server information
      assert.equal(response.headers['x-powered-by'], undefined, 'Should hide X-Powered-By');
      assert.equal(response.headers['server'], undefined, 'Should hide Server header');
      
      // Should prevent clickjacking
      assert.equal(response.headers['x-frame-options'], 'DENY', 'Should prevent clickjacking');
      assert.match(response.headers['content-security-policy'], /frame-src 'none'/, 'CSP should prevent framing');
    });
  });

  describe('Performance and Reliability', () => {
    test('security headers do not impact response time significantly', async () => {
      const app = createApp();
      
      const iterations = 10;
      const times: number[] = [];
      
      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        await request(app).get('/api/health');
        times.push(Date.now() - start);
      }
      
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      const maxTime = Math.max(...times);
      
      assert.ok(avgTime < 100, `Average response time should be < 100ms, got ${avgTime}ms`);
      assert.ok(maxTime < 200, `Max response time should be < 200ms, got ${maxTime}ms`);
    });

    test('handles concurrent requests with security headers', async () => {
      const app = createApp();
      
      const concurrentRequests = 20;
      const promises = Array.from({ length: concurrentRequests }, () =>
        request(app).get('/api/health')
      );
      
      const responses = await Promise.all(promises);
      
      // All requests should succeed
      responses.forEach((response, index) => {
        assert.equal(response.status, 200, `Request ${index} should succeed`);
        assert.ok(response.headers['content-security-policy'], `Request ${index} should have CSP`);
      });
    });
  });
});
