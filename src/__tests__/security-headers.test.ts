/**
 * Security Headers and CORS Tests
 * 
 * Tests production-safe security headers and CORS configuration
 */

import request from 'supertest';
import { createApp } from '../app.js';
import assert from 'node:assert';

// Mock better-sqlite3 to prevent native binding errors
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

describe('Security Headers and CORS Configuration', () => {
  describe('Helmet Security Headers', () => {
    test('applies Content Security Policy in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      try {
        const app = createApp();
        const response = await request(app).get('/api/health');
        
        expect(response.status).toBe(200);
        expect(response.headers['content-security-policy']).toBeDefined();
        expect(response.headers['content-security-policy']).toContain("default-src 'self'");
        expect(response.headers['content-security-policy']).toContain("script-src 'self'");
        expect(response.headers['content-security-policy']).toContain("object-src 'none'");
        expect(response.headers['content-security-policy']).toContain("frame-src 'none'");
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('applies relaxed CSP in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      try {
        const app = createApp();
        const response = await request(app).get('/api/health');
        
        expect(response.status).toBe(200);
        expect(response.headers['content-security-policy']).toBeDefined();
        // Development should allow unsafe-inline for styles
        expect(response.headers['content-security-policy']).toContain("'unsafe-inline'");
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('applies HSTS in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      try {
        const app = createApp();
        const response = await request(app).get('/api/health');
        
        expect(response.status).toBe(200);
        expect(response.headers['strict-transport-security']).toBeDefined();
        expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
        expect(response.headers['strict-transport-security']).toContain('includeSubDomains');
        expect(response.headers['strict-transport-security']).toContain('preload');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('does not apply HSTS in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      try {
        const app = createApp();
        const response = await request(app).get('/api/health');
        
        expect(response.status).toBe(200);
        expect(response.headers['strict-transport-security']).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('applies referrer policy', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.headers['referrer-policy']).toBeDefined();
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    test('applies X-Frame-Options', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.headers['x-frame-options']).toBeDefined();
      expect(response.headers['x-frame-options']).toBe('DENY');
    });

    test('applies X-Content-Type-Options', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBeDefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('CORS Configuration', () => {
    test('allows requests from configured origins', async () => {
      const originalEnv = process.env.CORS_ALLOWED_ORIGINS;
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';
      
      try {
        const app = createApp();
        const response = await request(app)
          .get('/api/health')
          .set('Origin', 'https://app.example.com');
        
        expect(response.status).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
        expect(response.headers['access-control-allow-credentials']).toBe('true');
      } finally {
        process.env.CORS_ALLOWED_ORIGINS = originalEnv;
      }
    });

    test('blocks requests from non-configured origins in production', async () => {
      const originalEnv = { ...process.env };
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      
      try {
        const app = createApp();
        const response = await request(app)
          .get('/api/health')
          .set('Origin', 'https://malicious.example.com');
        
        expect(response.status).toBe(500); // CORS error results in 500
        expect(response.body.error).toContain('CORS');
      } finally {
        process.env = originalEnv;
      }
    });

    test('allows localhost in development regardless of port', async () => {
      const originalEnv = { ...process.env };
      process.env.NODE_ENV = 'development';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      
      try {
        const app = createApp();
        
        // Test different localhost ports
        const ports = [3000, 3001, 5173, 8080];
        
        for (const port of ports) {
          const response = await request(app)
            .get('/api/health')
            .set('Origin', `http://localhost:${port}`);
          
          expect(response.status).toBe(200);
          expect(response.headers['access-control-allow-origin']).toBe(`http://localhost:${port}`);
        }
      } finally {
        process.env = originalEnv;
      }
    });

    test('allows requests with no origin (mobile apps, curl)', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      // Should not set ACAO header when no origin is present
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('handles preflight OPTIONS requests correctly', async () => {
      const originalEnv = process.env.CORS_ALLOWED_ORIGINS;
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      
      try {
        const app = createApp();
        const response = await request(app)
          .options('/api/health')
          .set('Origin', 'https://app.example.com')
          .set('Access-Control-Request-Method', 'GET')
          .set('Access-Control-Request-Headers', 'Content-Type');
        
        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
        expect(response.headers['access-control-allow-methods']).toContain('GET');
        expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
        expect(response.headers['access-control-max-age']).toBeDefined();
      } finally {
        process.env.CORS_ALLOWED_ORIGINS = originalEnv;
      }
    });

    test('includes additional allowed headers', async () => {
      const originalEnv = process.env.CORS_ALLOWED_ORIGINS;
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      
      try {
        const app = createApp();
        const response = await request(app)
          .options('/api/health')
          .set('Origin', 'https://app.example.com')
          .set('Access-Control-Request-Method', 'GET')
          .set('Access-Control-Request-Headers', 'x-user-id, x-request-id');
        
        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-headers']).toContain('x-user-id');
        expect(response.headers['access-control-allow-headers']).toContain('x-request-id');
      } finally {
        process.env.CORS_ALLOWED_ORIGINS = originalEnv;
      }
    });

    test('uses shorter max-age in production for security', async () => {
      const originalEnv = { ...process.env };
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      
      try {
        const app = createApp();
        const response = await request(app)
          .options('/api/health')
          .set('Origin', 'https://app.example.com')
          .set('Access-Control-Request-Method', 'GET');
        
        expect(response.status).toBe(204);
        expect(response.headers['access-control-max-age']).toBe('600'); // 10 minutes
      } finally {
        process.env = originalEnv;
      }
    });

    test('uses longer max-age in development for ergonomics', async () => {
      const originalEnv = { ...process.env };
      process.env.NODE_ENV = 'development';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';
      
      try {
        const app = createApp();
        const response = await request(app)
          .options('/api/health')
          .set('Origin', 'https://app.example.com')
          .set('Access-Control-Request-Method', 'GET');
        
        expect(response.status).toBe(204);
        expect(response.headers['access-control-max-age']).toBe('86400'); // 24 hours
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('Environment-based Security Configuration', () => {
    test('warns when no CORS origins configured in production', async () => {
      const originalEnv = { ...process.env };
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ALLOWED_ORIGINS;
      
      // Mock console.warn to capture warning
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      try {
        const app = createApp();
        await request(app).get('/api/health');
        
        // Should have logged a warning
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('WARNING: No CORS_ALLOWED_ORIGINS configured in production')
        );
      } finally {
        process.env = originalEnv;
        consoleSpy.mockRestore();
      }
    });

    test('applies Cross-Origin Embedder Policy in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      try {
        const app = createApp();
        const response = await request(app).get('/api/health');
        
        expect(response.status).toBe(200);
        expect(response.headers['cross-origin-embedder-policy']).toBeDefined();
        expect(response.headers['cross-origin-embedder-policy']).toContain('require-corp');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('hides X-Powered-By header in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      try {
        const app = createApp();
        const response = await request(app).get('/api/health');
        
        expect(response.status).toBe(200);
        expect(response.headers['x-powered-by']).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });
});
