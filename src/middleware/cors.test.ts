import express from 'express';
import request from 'supertest';
import {
  createCorsAllowlistMiddleware,
  createMaintenanceCorsMiddleware,
  createSubscriptionCorsMiddleware,
  createApisCorsMiddleware,
  parseAllowedOrigins,
  CORS_ERROR_CODE,
} from './cors.js';
import { errorHandler } from './errorHandler.js';

function buildApp(allowedOrigins: string[]) {
  const app = express();
  app.use(express.json());
  const corsMw = createCorsAllowlistMiddleware({
    allowedOrigins,
    allowCredentials: true,
    maxAgeSeconds: 600,
  });
  app.use('/test', corsMw, (_req, res) => {
    res.json({ success: true });
  });
  app.use(errorHandler);
  return app;
}

describe('createCorsAllowlistMiddleware', () => {
  describe('origin validation', () => {
    it('allows requests from an allowed origin', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://trusted.example.com')
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('sets Access-Control-Allow-Origin header for allowed origins', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://trusted.example.com')
        .send({});
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://trusted.example.com',
      );
    });

    it('denies requests from an origin not in the allowlist', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://evil.example.com')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(CORS_ERROR_CODE);
    });

    it('denies requests with no Origin header', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app).post('/test').send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(CORS_ERROR_CODE);
    });

    it('denies all origins when allowlist is empty (deny by default)', async () => {
      const app = buildApp([]);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://trusted.example.com')
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe('preflight handling', () => {
    it('responds with 204 for allowed OPTIONS preflight', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .options('/test')
        .set('Origin', 'https://trusted.example.com');
      expect(res.status).toBe(204);
    });

    it('sets Access-Control-Max-Age header on preflight (issue #940: preflight cached)', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .options('/test')
        .set('Origin', 'https://trusted.example.com');
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('sets Access-Control-Allow-Methods on preflight', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .options('/test')
        .set('Origin', 'https://trusted.example.com');
      expect(res.headers['access-control-allow-methods']).toBeDefined();
    });

    it('denies preflight from disallowed origin', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .options('/test')
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
    });

    it('returns 204 (preflight cached) without invoking downstream handler', async () => {
      let downstreamCalled = false;
      const app = express();
      const corsMw = createCorsAllowlistMiddleware({
        allowedOrigins: ['https://trusted.example.com'],
      });
      app.use(
        '/t',
        corsMw,
        (_req, res) => {
          downstreamCalled = true;
          res.json({ ok: true });
        },
      );
      const res = await request(app)
        .options('/t')
        .set('Origin', 'https://trusted.example.com');
      expect(res.status).toBe(204);
      expect(downstreamCalled).toBe(false);
    });
  });

  describe('credentials support', () => {
    it('sets Access-Control-Allow-Credentials when enabled', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://trusted.example.com')
        .send({});
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not set Access-Control-Allow-Credentials when disabled', async () => {
      const app = express();
      const corsMw = createCorsAllowlistMiddleware({
        allowedOrigins: ['https://trusted.example.com'],
      });
      app.use('/t', corsMw, (_req, res) => res.json({ ok: true }));
      const res = await request(app)
        .get('/t')
        .set('Origin', 'https://trusted.example.com');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('error envelope shape', () => {
    it('returns the canonical envelope with requestId on deny', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://evil.example.com')
        .set('X-Request-Id', 'req-abc-123')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: CORS_ERROR_CODE },
        requestId: 'req-abc-123',
      });
      expect(typeof res.body.timestamp).toBe('string');
      expect(res.body.error.message).toBe(
        'Origin "https://evil.example.com" is not allowed',
      );
    });

    it('returns generic requestId when X-Request-Id is missing on deny', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const res = await request(app)
        .post('/test')
        .set('Origin', 'https://evil.example.com')
        .send({});
      expect(res.status).toBe(403);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.body.requestId.length).toBeGreaterThan(0);
    });

    it('sets Vary: Origin on both allow and deny responses', async () => {
      const app = buildApp(['https://trusted.example.com']);
      const allowed = await request(app)
        .post('/test')
        .set('Origin', 'https://trusted.example.com')
        .send({});
      expect(allowed.headers['vary']).toContain('Origin');

      const denied = await request(app)
        .post('/test')
        .set('Origin', 'https://evil.example.com')
        .send({});
      expect(denied.headers['vary']).toContain('Origin');
    });
  });
});

describe('parseAllowedOrigins', () => {
  it('returns an empty array for undefined input', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('returns an empty array for null input', () => {
    expect(parseAllowedOrigins(null)).toEqual([]);
  });

  it('returns an empty array for empty string', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
  });

  it('parses a single origin unchanged', () => {
    expect(parseAllowedOrigins('https://app.example.com')).toEqual([
      'https://app.example.com',
    ]);
  });

  it('parses comma-separated origins', () => {
    expect(
      parseAllowedOrigins('https://a.example.com, https://b.example.com '),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('drops empty entries from the comma list', () => {
    expect(parseAllowedOrigins('a,, ,b,')).toEqual(['a', 'b']);
  });

  it('deduplicates repeated origins', () => {
    expect(parseAllowedOrigins('a,a,b,a,b')).toEqual(['a', 'b']);
  });

  it('treats whitespace-only strings as empty', () => {
    expect(parseAllowedOrigins('   , ,')).toEqual([]);
  });
});

describe('createMaintenanceCorsMiddleware', () => {
  const originalEnv = process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
    } else {
      process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS = originalEnv;
    }
  });

  it('denies by default when MAINTENANCE_CORS_ALLOWED_ORIGINS is unset', async () => {
    delete process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
    const app = express();
    app.use(
      '/m',
      createMaintenanceCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/m')
      .set('Origin', 'https://admin.example.com');
    expect(res.status).toBe(403);
  });

  it('denies an origin not on the allowlist', async () => {
    process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS =
      'https://allowed.example.com';
    const app = express();
    app.use(
      '/m',
      createMaintenanceCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/m')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  it('allows an origin that is on the allowlist', async () => {
    process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS =
      'https://allowed.example.com,https://also-ok.example.com';
    const app = express();
    app.use(
      '/m',
      createMaintenanceCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/m')
      .set('Origin', 'https://also-ok.example.com');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('caches the preflight result (Access-Control-Max-Age header set)', async () => {
    process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS =
      'https://allowed.example.com';
    const app = express();
    app.use(
      '/m',
      createMaintenanceCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .options('/m')
      .set('Origin', 'https://allowed.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('includes Access-Control-Allow-Credentials for the maintenance route', async () => {
    process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS =
      'https://allowed.example.com';
    const app = express();
    app.use(
      '/m',
      createMaintenanceCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/m')
      .set('Origin', 'https://allowed.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('createSubscriptionCorsMiddleware', () => {
  const originalEnv = process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS;
    } else {
      process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS = originalEnv;
    }
  });

  it('denies by default when SUBSCRIPTION_CORS_ALLOWED_ORIGINS is unset', async () => {
    delete process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS;
    const app = express();
    app.use(
      '/s',
      createSubscriptionCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/s')
      .set('Origin', 'https://app.example.com');
    expect(res.status).toBe(403);
  });

  it('denies an origin not on the allowlist', async () => {
    process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS =
      'https://trusted.example.com';
    const app = express();
    app.use(
      '/s',
      createSubscriptionCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/s')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  it('allows an origin that is on the allowlist', async () => {
    process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS =
      'https://trusted.example.com,https://also-ok.example.com';
    const app = express();
    app.use(
      '/s',
      createSubscriptionCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/s')
      .set('Origin', 'https://also-ok.example.com');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('caches the preflight result (Access-Control-Max-Age header set)', async () => {
    process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS =
      'https://trusted.example.com';
    const app = express();
    app.use(
      '/s',
      createSubscriptionCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .options('/s')
      .set('Origin', 'https://trusted.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('does NOT set Access-Control-Allow-Credentials for subscription route', async () => {
    process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS =
      'https://trusted.example.com';
    const app = express();
    app.use(
      '/s',
      createSubscriptionCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/s')
      .set('Origin', 'https://trusted.example.com');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('createApisCorsMiddleware', () => {
  const originalEnv = process.env.APIS_CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.APIS_CORS_ALLOWED_ORIGINS;
    } else {
      process.env.APIS_CORS_ALLOWED_ORIGINS = originalEnv;
    }
  });

  it('denies by default when APIS_CORS_ALLOWED_ORIGINS is unset', async () => {
    delete process.env.APIS_CORS_ALLOWED_ORIGINS;
    const app = express();
    app.use(
      '/a',
      createApisCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/a')
      .set('Origin', 'https://admin.example.com');
    expect(res.status).toBe(403);
  });

  it('denies an origin not on the allowlist', async () => {
    process.env.APIS_CORS_ALLOWED_ORIGINS = 'https://allowed.example.com';
    const app = express();
    app.use(
      '/a',
      createApisCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/a')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
  });

  it('allows an origin that is on the allowlist', async () => {
    process.env.APIS_CORS_ALLOWED_ORIGINS =
      'https://allowed.example.com,https://also-ok.example.com';
    const app = express();
    app.use(
      '/a',
      createApisCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/a')
      .set('Origin', 'https://also-ok.example.com');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('caches the preflight result (Access-Control-Max-Age header set)', async () => {
    process.env.APIS_CORS_ALLOWED_ORIGINS = 'https://allowed.example.com';
    const app = express();
    app.use(
      '/a',
      createApisCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .options('/a')
      .set('Origin', 'https://allowed.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('includes Access-Control-Allow-Credentials for the apis route', async () => {
    process.env.APIS_CORS_ALLOWED_ORIGINS = 'https://allowed.example.com';
    const app = express();
    app.use(
      '/a',
      createApisCorsMiddleware(),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app)
      .get('/a')
      .set('Origin', 'https://allowed.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

