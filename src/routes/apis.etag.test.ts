/**
 * @file src/routes/apis.etag.test.ts
 * @description Integration tests for ETag / 304 Not Modified support on
 * GET /api/apis and GET /api/apis/:id (issue #866).
 *
 * Style deliberately mirrors src/routes/apis.test.ts: same mocking approach,
 * same InMemoryApiRepository, same express + supertest setup.
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { InMemoryApiRepository } from '../repositories/apiRepository.js';
import { createApisRouter } from './apis.js';
import { ListingsCache } from '../lib/listingsCache.js';

// ── Shared test data ─────────────────────────────────────────────────────────

const ACTIVE_API = {
  id: 1,
  name: 'Weather API',
  description: 'Provides weather data',
  base_url: 'https://api.weather.test',
  logo_url: null,
  category: 'weather',
  status: 'active' as const,
  developer: {
    name: 'Acme Corp',
    website: 'https://acme.test',
    description: 'Leading data provider',
  },
};

const ENDPOINTS_MAP = new Map([
  [
    1,
    [
      {
        path: '/current',
        method: 'GET' as const,
        price_per_call_usdc: '0.01',
        description: 'Current weather',
      },
    ],
  ],
]);

// ── App builder ──────────────────────────────────────────────────────────────

function buildApp(overrideApis = [ACTIVE_API], endpointsMap = ENDPOINTS_MAP) {
  const repo = new InMemoryApiRepository(overrideApis, endpointsMap);
  // Fresh cache per test so tests are fully isolated
  const cache = new ListingsCache({ ttlMs: 30_000 });

  const app = express();
  app.use(
    '/api/apis',
    createApisRouter({ apiRepository: repo, cache }),
  );
  app.use(errorHandler);
  return { app, repo, cache };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/apis — ETag + 304
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/apis — ETag caching', () => {
  it('returns 200 with an ETag header on the first request', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/apis');

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeDefined();
    // Must be a strong ETag (no W/ prefix) wrapped in double-quotes
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  });

  it('returns 304 with no body when If-None-Match matches the current ETag', async () => {
    const { app } = buildApp();

    // First request — get the ETag
    const first = await request(app).get('/api/apis');
    expect(first.status).toBe(200);
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    // Second request with matching If-None-Match
    const second = await request(app)
      .get('/api/apis')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    // 304 must have no body (text representation of body should be empty)
    expect(second.text).toBe('');
  });

  it('the 304 response still carries the ETag header', async () => {
    const { app } = buildApp();

    const first = await request(app).get('/api/apis');
    const etag = first.headers['etag'];

    const second = await request(app)
      .get('/api/apis')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.headers['etag']).toBe(etag);
  });

  it('returns 200 with the current body when If-None-Match is stale', async () => {
    const { app } = buildApp();

    const staleETag = '"0000000000000000000000000000abcd"';
    const res = await request(app)
      .get('/api/apis')
      .set('If-None-Match', staleETag);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    // The response must carry the current (new) ETag, not the stale one
    expect(res.headers['etag']).not.toBe(staleETag);
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  });

  it('ETag changes when the underlying data changes', async () => {
    // Build two separate apps — one with one API, one with two APIs —
    // both using an empty cache to ensure DB reads happen.
    const cacheA = new ListingsCache({ ttlMs: 30_000 });
    const repoA = new InMemoryApiRepository([ACTIVE_API], ENDPOINTS_MAP);
    const appA = express();
    appA.use('/api/apis', createApisRouter({ apiRepository: repoA, cache: cacheA }));
    appA.use(errorHandler);

    const cacheB = new ListingsCache({ ttlMs: 30_000 });
    const repoB = new InMemoryApiRepository(
      [
        ACTIVE_API,
        {
          id: 2,
          name: 'Translate API',
          description: null,
          base_url: 'https://api.translate.test',
          logo_url: null,
          category: 'language',
          status: 'active' as const,
          developer: { name: 'New Dev', website: null, description: null },
        },
      ],
      ENDPOINTS_MAP,
    );
    const appB = express();
    appB.use('/api/apis', createApisRouter({ apiRepository: repoB, cache: cacheB }));
    appB.use(errorHandler);

    const first = await request(appA).get('/api/apis');
    const etagBefore = first.headers['etag'];

    const second = await request(appB).get('/api/apis');
    const etagAfter = second.headers['etag'];

    expect(etagBefore).toBeDefined();
    expect(etagAfter).toBeDefined();
    expect(etagBefore).not.toBe(etagAfter);
  });

  it('handles a malformed If-None-Match header gracefully (returns 200, not 500)', async () => {
    const { app } = buildApp();

    // A header value that is not a valid quoted ETag
    const res = await request(app)
      .get('/api/apis')
      .set('If-None-Match', '!!!not-valid!!!');

    // Must fall back to a normal 200 response — never a 500
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('returns 304 when If-None-Match contains the matching ETag in a list', async () => {
    const { app } = buildApp();

    const first = await request(app).get('/api/apis');
    const etag = first.headers['etag'];

    // Client sends a list of ETags including the current one
    const second = await request(app)
      .get('/api/apis')
      .set('If-None-Match', `"stale0000000000000000000000000000", ${etag}`);

    expect(second.status).toBe(304);
  });

  it('returns 304 for wildcard If-None-Match: *', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/apis')
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
  });

  it('returns 304 when If-None-Match contains the matching weak ETag', async () => {
    const { app } = buildApp();

    const first = await request(app).get('/api/apis');
    const etag = first.headers['etag']; // e.g. "abc..."
    // Client sends a weak version of the same ETag
    const weakETag = `W/${etag}`;

    const second = await request(app)
      .get('/api/apis')
      .set('If-None-Match', weakETag);

    // Weak comparison is used for If-None-Match — must still match
    expect(second.status).toBe(304);
  });

  it('ETag is identical for two requests with the same data (deterministic)', async () => {
    const { app } = buildApp();

    const first = await request(app).get('/api/apis');
    const second = await request(app).get('/api/apis');

    expect(first.headers['etag']).toBe(second.headers['etag']);
  });

  it('ETag is different for different pagination params', async () => {
    const repo = new InMemoryApiRepository(
      [
        ACTIVE_API,
        {
          id: 3,
          name: 'Second API',
          description: null,
          base_url: 'https://api2.test',
          logo_url: null,
          category: 'other',
          status: 'active' as const,
          developer: { name: 'Dev B', website: null, description: null },
        },
      ],
      ENDPOINTS_MAP,
    );
    const cache = new ListingsCache({ ttlMs: 30_000 });
    const app = express();
    app.use('/api/apis', createApisRouter({ apiRepository: repo, cache }));
    app.use(errorHandler);

    const page1 = await request(app).get('/api/apis?limit=1&offset=0');
    const page2 = await request(app).get('/api/apis?limit=1&offset=1');

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.headers['etag']).not.toBe(page2.headers['etag']);
  });

  it('cache-hit path still returns 304 on matching If-None-Match', async () => {
    const { app } = buildApp();

    // First request — populates the in-process ListingsCache
    const first = await request(app).get('/api/apis');
    const etag = first.headers['etag'];

    // Second request hits the ListingsCache (no DB) and still evaluates ETag
    const second = await request(app)
      .get('/api/apis')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/apis/:id — ETag + 304
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/apis/:id — ETag caching', () => {
  it('returns 200 with a strong ETag header', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/apis/1');

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  });

  it('returns 304 with no body when If-None-Match matches', async () => {
    const { app } = buildApp();

    const first = await request(app).get('/api/apis/1');
    const etag = first.headers['etag'];

    const second = await request(app)
      .get('/api/apis/1')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.headers['etag']).toBe(etag);
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/apis/1')
      .set('If-None-Match', '"stale0000000000000000000000000000"');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]+"$/);
  });

  it('handles a malformed If-None-Match header gracefully (returns 200)', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/apis/1')
      .set('If-None-Match', '!!!bad!!!');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  it('returns 304 for wildcard If-None-Match: *', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/apis/1')
      .set('If-None-Match', '*');

    expect(res.status).toBe(304);
  });

  it('does not emit an ETag on 404 responses', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/apis/9999');

    expect(res.status).toBe(404);
    // 404 responses come from the error handler and must not carry an ETag
    expect(res.headers['etag']).toBeUndefined();
  });

  it('ETag differs between different APIs', async () => {
    const repo = new InMemoryApiRepository(
      [
        ACTIVE_API,
        {
          id: 2,
          name: 'Different API',
          description: null,
          base_url: 'https://different.test',
          logo_url: null,
          category: 'other',
          status: 'active' as const,
          developer: { name: 'Other Dev', website: null, description: null },
        },
      ],
      new Map([[1, []], [2, []]]),
    );
    const app = express();
    app.use('/api/apis', createApisRouter({ apiRepository: repo }));
    app.use(errorHandler);

    const api1 = await request(app).get('/api/apis/1');
    const api2 = await request(app).get('/api/apis/2');

    expect(api1.headers['etag']).not.toBe(api2.headers['etag']);
  });
});
