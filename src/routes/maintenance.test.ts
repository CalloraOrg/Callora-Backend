import express from 'express';
import request from 'supertest';
import publicMaintenanceRouter from './maintenance.js';
import {
  activeMaintenanceWindow,
  maintenanceRouter,
} from './admin/maintenance.js';

/**
 * Focused tests for the public read-only /api/maintenance endpoint
 * (issue #940 — CORS allowlist enforcement on the maintenance route).
 *
 * These tests verify:
 *  - The endpoint returns a 200 with the live maintenance window state.
 *  - The endpoint rejects cross-origin browsers with 403 when the origin
 *    is not in MAINTENANCE_CORS_ALLOWED_ORIGINS (deny by default).
 *  - Preflight requests are answered 204 with Access-Control-Max-Age
 *    so browsers cache the result.
 *  - The endpoint shares state with the admin router (snapshot reflects
 *    admin POST writes).
 */

// Save/restore the env var so other tests aren't affected.
const ORIGINAL_ENV = process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/maintenance', publicMaintenanceRouter);
  // The admin router only mounts the POST endpoint for purposes of these
  // tests so we can mutate the shared state; the maintenanceCors middleware
  // requires an Origin header from the allowlist.
  app.use('/api/admin', maintenanceRouter);
  return app;
}

beforeEach(() => {
  process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS =
    'http://localhost:5173,https://admin.example.com';
  // Reset the shared window state to its initial value so tests don't leak
  // activeMaintenanceWindow across cases.
  resetMaintenanceWindow();
});

afterEach(() => {
  // Belt-and-braces — also reset after each test in case a future test
  // file in the same Jest worker mutates the singleton.
  resetMaintenanceWindow();
});

function resetMaintenanceWindow(): void {
  activeMaintenanceWindow.isEnabled = false;
  activeMaintenanceWindow.startTime = null;
  activeMaintenanceWindow.endTime = null;
  activeMaintenanceWindow.reason = '';
}

afterAll(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS;
  } else {
    process.env.MAINTENANCE_CORS_ALLOWED_ORIGINS = ORIGINAL_ENV;
  }
});

describe('public /api/maintenance — CORS allowlist enforcement (issue #940)', () => {
  describe('happy path with allowlisted origin', () => {
    it('returns 200 with the live maintenance window state', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: {
          isEnabled: false,
          startTime: null,
          endTime: null,
          reason: '',
        },
      });
      expect(typeof res.body.requestId).toBe('string');
    });

    it('sets Access-Control-Allow-Origin and Vary: Origin on success', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'https://admin.example.com');
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://admin.example.com',
      );
      expect(res.headers['vary']).toContain('Origin');
    });

    it('exposes Access-Control-Allow-Credentials because credentials are enabled', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('echoes the X-Request-Id correlation header in the response', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173')
        .set('X-Request-Id', 'req-test-12345');
      expect(res.body.requestId).toBe('req-test-12345');
    });
  });

  describe('CORS denial paths', () => {
    // NOTE: the empty-allowlist / unset-env deny-by-default scenario is
    // covered at the unit level in `src/middleware/cors.test.ts`; trying
    // to assert it here against the cached module-level middleware
    // closure is futile because the closure reads the env once on the
    // first request and never resets within the file.

    it('denies origins not on the allowlist', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('denies requests with no Origin header (no same-origin unauthenticated access)', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/maintenance');
      expect(res.status).toBe(403);
    });

    it('denies preflight from a non-allowlisted origin', async () => {
      const app = buildApp();
      const res = await request(app)
        .options('/api/maintenance')
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
    });
  });

  describe('preflight caching (issue #940: preflight cached)', () => {
    it('responds 204 for an allowlisted preflight', async () => {
      const app = buildApp();
      const res = await request(app)
        .options('/api/maintenance')
        .set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(204);
    });

    it('sets Access-Control-Max-Age so the browser caches the preflight result', async () => {
      const app = buildApp();
      const res = await request(app)
        .options('/api/maintenance')
        .set('Origin', 'http://localhost:5173');
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('returns the expected Access-Control-Allow-Methods on preflight', async () => {
      const app = buildApp();
      const res = await request(app)
        .options('/api/maintenance')
        .set('Origin', 'http://localhost:5173');
      const methods = res.headers['access-control-allow-methods'];
      expect(methods).toBeDefined();
      expect(methods).toMatch(/GET/);
      expect(methods).toMatch(/POST/);
      expect(methods).toMatch(/OPTIONS/);
    });
  });

  describe('state shared with the admin router', () => {
    it('reflects admin POST writes on subsequent GET requests', async () => {
      const app = buildApp();

      // POST through the admin router to flip the window state. We need
      // an Origin header because the cors middleware guards everything.
      await request(app)
        .post('/api/admin/maintenance')
        .set('Origin', 'http://localhost:5173')
        .send({
          isEnabled: true,
          startTime: '2027-01-01T00:00:00.000Z',
          endTime: '2027-01-02T00:00:00.000Z',
          reason: 'Coordinated maintenance',
        })
        .expect(200);

      const get = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'https://admin.example.com')
        .expect(200);

      expect(get.body.data).toMatchObject({
        isEnabled: true,
        startTime: '2027-01-01T00:00:00.000Z',
        endTime: '2027-01-02T00:00:00.000Z',
        reason: 'Coordinated maintenance',
      });
    });
  });

  describe('ETag / 304 caching (issue #021)', () => {
    it('returns a strong ETag on first request', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173');
      
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBeDefined();
      expect(res.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    });

    it('returns 304 Not Modified when If-None-Match matches', async () => {
      const app = buildApp();
      const firstRes = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173');
      
      const etag = firstRes.headers.etag;
      
      const secondRes = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173')
        .set('If-None-Match', etag);
      
      expect(secondRes.status).toBe(304);
      expect(secondRes.body).toEqual({});
      expect(secondRes.headers['content-type']).toBeUndefined();
      expect(secondRes.headers['content-length']).toBeUndefined();
    });

    it('returns 200 OK when If-None-Match does not match', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/maintenance')
        .set('Origin', 'http://localhost:5173')
        .set('If-None-Match', '"invalidetag"');
      
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBeDefined();
    });
  });
});
