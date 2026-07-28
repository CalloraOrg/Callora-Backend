/**
 * Tests for src/middleware/etag.ts
 *
 * Covers:
 *   - generateETag: produces a quoted SHA-256 strong ETag
 *   - etagMatches:  RFC 7232 §3.2 strong comparison logic
 *   - etagMiddleware: end-to-end behaviour with supertest
 *
 * All test Express apps call `app.disable('etag')` to prevent the framework's
 * own weak-ETag feature from interfering with assertions about our middleware.
 */

import request from 'supertest';
import express from 'express';
import { etagMiddleware, generateETag, etagMatches } from './etag.js';

describe('generateETag', () => {
  test('returns a quoted hex-digest string (strong ETag format)', () => {
    const tag = generateETag('hello world');
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  test('is deterministic for the same input', () => {
    expect(generateETag('foo')).toBe(generateETag('foo'));
  });

  test('differs for different inputs', () => {
    expect(generateETag('foo')).not.toBe(generateETag('bar'));
  });

  test('accepts a Buffer', () => {
    const tag = generateETag(Buffer.from('hello'));
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(tag).toBe(generateETag('hello'));
  });

  test('does not include a W/ weak prefix', () => {
    expect(generateETag('test')).not.toContain('W/');
  });
});

describe('etagMatches', () => {
  const etag = '"abc123"';

  test('matches an identical strong ETag', () => {
    expect(etagMatches(etag, etag)).toBe(true);
  });

  test('wildcard * matches any ETag', () => {
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('  *  ', etag)).toBe(true);
  });

  test('does not match a different ETag', () => {
    expect(etagMatches('"xyz999"', etag)).toBe(false);
  });

  test('does not match a weak version of the same digest (strong comparison)', () => {
    expect(etagMatches('W/"abc123"', etag)).toBe(false);
  });

  test('matches when the target ETag is one of several comma-separated tags', () => {
    expect(etagMatches('"other1", "abc123", "other2"', etag)).toBe(true);
  });

  test('does not match when the list contains only unrelated tags', () => {
    expect(etagMatches('"other1", "other2"', etag)).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// etagMiddleware — integration via supertest
// ---------------------------------------------------------------------------
describe('etagMiddleware', () => {
  function makeApp(handler: Parameters<typeof express.Router.prototype.get>[1]) {
    const app = express();
    app.disable('etag');
    app.get('/test', etagMiddleware, handler);
    return app;
  }

  test('sets a strong ETag header and returns 200 for a GET request', async () => {
    const app = makeApp((_req, res) => {
      res.json({ message: 'hello world' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.body).toEqual({ message: 'hello world' });
  });

  test('returns 304 Not Modified when If-None-Match matches the ETag', async () => {
    const app = makeApp((_req, res) => {
      res.json({ message: 'hello world' });
    });

    const first = await request(app).get('/test');
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    const second = await request(app).get('/test').set('If-None-Match', etag);
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  test('returns 304 when If-None-Match is a wildcard', async () => {
    const app = makeApp((_req, res) => {
      res.json({ data: 'x' });
    });

    const res = await request(app).get('/test').set('If-None-Match', '*');
    expect(res.status).toBe(304);
  });

  test('returns 304 when If-None-Match contains multiple tags and one matches', async () => {
    const app = makeApp((_req, res) => {
      res.json({ n: 1 });
    });

    const first = await request(app).get('/test');
    const etag = first.headers.etag as string;

    const second = await request(app)
      .get('/test')
      .set('If-None-Match', `"stale-one", ${etag}, "stale-two"`);
    expect(second.status).toBe(304);
  });

  test('returns 200 when If-None-Match does not match the ETag', async () => {
    const app = makeApp((_req, res) => {
      res.json({ message: 'hello world' });
    });

    const res = await request(app)
      .get('/test')
      .set('If-None-Match', '"different-hash"');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hello world' });
  });

  test('does NOT return 304 when client sends a weak ETag (strong comparison only)', async () => {
    const app = makeApp((_req, res) => {
      res.json({ data: 1 });
    });

    const first = await request(app).get('/test');
    const etag = first.headers.etag as string;
    const weakTag = `W/${etag}`;

    const second = await request(app).get('/test').set('If-None-Match', weakTag);
    expect(second.status).toBe(200);
  });

  test('does not set ETag for non-GET/HEAD requests', async () => {
    const app = express();
    app.disable('etag');
    app.use(express.json());
    app.post('/test', etagMiddleware, (_req, res) => {
      res.json({ message: 'created' });
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(200);
    // Our middleware skips non-GET/HEAD methods entirely — no ETag
    expect(res.headers.etag).toBeUndefined();
  });

  test('does not override an ETag that is already set by the route', async () => {
    const existingTag = '"preset-etag"';
    const app = express();
    app.disable('etag');
    app.get('/test', etagMiddleware, (_req, res) => {
      res.setHeader('ETag', existingTag);
      res.json({ data: 'y' });
    });

    const res = await request(app).get('/test');
    expect(res.headers.etag).toBe(existingTag);
  });

  test('does not set ETag for non-200 status codes', async () => {
    const app = express();
    app.disable('etag');
    app.get('/test', etagMiddleware, (_req, res) => {
      res.status(404).json({ error: 'not found' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    // Our middleware only sets ETag on 200 OK
    expect(res.headers.etag).toBeUndefined();
  });


});
