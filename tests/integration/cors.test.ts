process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';

import { jest } from '@jest/globals';

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => {
    return {
      prepare: jest.fn().mockReturnValue({ get: jest.fn() }),
      exec: jest.fn(),
      close: jest.fn(),
    };
  });
});

import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('CORS Integration Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { 
      ...originalEnv,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      ADMIN_API_KEY: 'test-admin-key',
      METRICS_API_KEY: 'test-metrics-key',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Production Mode', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ALLOWED_ORIGINS = 'https://app.callora.com,https://api.callora.com';
    });

    it('should allow origins in the allowlist', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'https://app.callora.com');

      expect(res.header['access-control-allow-origin']).toBe('https://app.callora.com');
      expect(res.status).toBe(200);
    });

    it('should block origins NOT in the allowlist', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'https://malicious.com');

      expect(res.header['access-control-allow-origin']).toBeUndefined();
      // Browsers block this on the client side when headers are missing
    });

    it('should allow requests with no origin (e.g., mobile apps)', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/api/health');

      expect(res.header['access-control-allow-origin']).toBeUndefined();
      expect(res.status).toBe(200);
    });

    it('should handle comma-separated allowlist with whitespace', async () => {
      process.env.CORS_ALLOWED_ORIGINS = ' https://app.callora.com , https://api.callora.com ';
      const app = createApp();
      
      const res1 = await request(app)
        .get('/api/health')
        .set('Origin', 'https://app.callora.com');
      expect(res1.header['access-control-allow-origin']).toBe('https://app.callora.com');

      const res2 = await request(app)
        .get('/api/health')
        .set('Origin', 'https://api.callora.com');
      expect(res2.header['access-control-allow-origin']).toBe('https://api.callora.com');
    });
  });

  describe('Development Mode', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
    });

    it('should allow localhost with any port in development', async () => {
      const app = createApp();
      
      const res1 = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost:3000');
      expect(res1.header['access-control-allow-origin']).toBe('http://localhost:3000');

      const res2 = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost:8080');
      expect(res2.header['access-control-allow-origin']).toBe('http://localhost:8080');
    });

    it('should allow localhost without port in development', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost');
      expect(res.header['access-control-allow-origin']).toBe('http://localhost');
    });

    it('should block suspicious localhost-like origins even in development', async () => {
      const app = createApp();
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost-malicious.com');
      
      expect(res.header['access-control-allow-origin']).toBeUndefined();
    });
  });
});
