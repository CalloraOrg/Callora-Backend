import express from 'express';
import request from 'supertest';
import { createRouteBodyLimitMiddleware } from './routeBodyLimit.js';

function createTestApp(
  rules: Array<{ method: string; route: string; limit: string }>,
  opts?: { fallbackLimit?: string },
) {
  const app = express();

  app.use(createRouteBodyLimitMiddleware(rules));
  if (opts?.fallbackLimit) {
    app.use(express.json({ limit: opts.fallbackLimit }));
  } else {
    app.use(express.json());
  }

  app.post('/upload', (_req, res) => {
    res.status(201).json({ ok: true, route: 'upload' });
  });

  app.put('/upload', (_req, res) => {
    res.status(200).json({ ok: true, route: 'upload-put' });
  });

  app.post('/api/v1/submit', (_req, res) => {
    res.status(201).json({ ok: true, route: 'submit' });
  });

  app.post('/api/v1/:id/data', (_req, res) => {
    res.status(201).json({ ok: true, route: 'param-data' });
  });

  app.get('/upload', (_req, res) => {
    res.status(200).json({ ok: true, route: 'upload-get' });
  });

  app.post('/no-rule', (_req, res) => {
    res.status(201).json({ ok: true, route: 'no-rule' });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof err === 'object' && err && 'status' in err && typeof (err as { status?: number }).status === 'number'
          ? (err as { status: number }).status
          : 500;

      res.status(status).json({
        code: status === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'INTERNAL_SERVER_ERROR',
        message: status === 413 ? 'Request body too large' : 'Internal server error',
      });
    },
  );

  return app;
}

describe('createRouteBodyLimitMiddleware', () => {
  describe('basic size enforcement', () => {
    it('returns 413 for oversized bodies on a configured route', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '10kb' }]);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(12000) });

      expect(response.status).toBe(413);
      expect(response.body).toEqual({
        code: 'REQUEST_BODY_TOO_LARGE',
        message: 'Request body too large',
      });
    });

    it('allows bodies that stay within the configured route limit', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '20kb' }]);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(12000) });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ ok: true, route: 'upload' });
    });

    it('allows empty bodies', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '1kb' }]);

      const response = await request(app).post('/upload').send({});

      expect(response.status).toBe(201);
    });
  });

  describe('HTTP method handling', () => {
    it('skips body parsing for GET requests', async () => {
      const app = createTestApp([{ method: 'GET', route: '/upload', limit: '1kb' }]);

      const response = await request(app).get('/upload');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, route: 'upload-get' });
    });

    it('skips body parsing for HEAD requests', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '1kb' }]);

      const response = await request(app).head('/upload');

      expect(response.status).toBe(200);
    });

    it('enforces limit on PUT requests', async () => {
      const app = createTestApp([{ method: 'PUT', route: '/upload', limit: '1kb' }]);

      const response = await request(app)
        .put('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });

    it('enforces limit on PATCH requests', async () => {
      const app = createTestApp([{ method: 'PATCH', route: '/upload', limit: '1kb' }]);

      app.patch('/upload', (_req, res) => {
        res.status(200).json({ ok: true });
      });

      const response = await request(app)
        .patch('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });

    it('enforces limit on DELETE requests with body', async () => {
      const app = createTestApp([{ method: 'DELETE', route: '/upload', limit: '1kb' }]);

      app.delete('/upload', (_req, res) => {
        res.status(200).json({ ok: true });
      });

      const response = await request(app)
        .delete('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });

    it('wildcard method matches all HTTP methods', async () => {
      const app = createTestApp([{ method: '*', route: '/upload', limit: '1kb' }]);

      const postResponse = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(postResponse.status).toBe(413);
    });
  });

  describe('multiple rules', () => {
    it('applies different limits to different routes', async () => {
      const app = createTestApp([
        { method: 'POST', route: '/upload', limit: '1kb' },
        { method: 'POST', route: '/api/v1/submit', limit: '50kb' },
      ]);

      const smallRouteResponse = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(smallRouteResponse.status).toBe(413);

      const largeRouteResponse = await request(app)
        .post('/api/v1/submit')
        .send({ payload: 'x'.repeat(2000) });

      expect(largeRouteResponse.status).toBe(201);
    });

    it('applies different limits to different methods on same route', async () => {
      const app = createTestApp([
        { method: 'POST', route: '/upload', limit: '1kb' },
        { method: 'PUT', route: '/upload', limit: '50kb' },
      ]);

      const postResponse = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(postResponse.status).toBe(413);

      const putResponse = await request(app)
        .put('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(putResponse.status).toBe(200);
    });
  });

  describe('route matching', () => {
    it('matches parameterized routes', async () => {
      const app = createTestApp([{ method: 'POST', route: '/api/v1/:id/data', limit: '1kb' }]);

      const response = await request(app)
        .post('/api/v1/abc123/data')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });

    it('matches wildcard route patterns', async () => {
      const app = createTestApp([{ method: 'POST', route: '/api/*', limit: '1kb' }]);

      const response = await request(app)
        .post('/api/v1/anything/here')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });

    it('does not apply limit to unmatched routes', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '1kb' }]);

      const response = await request(app)
        .post('/no-rule')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ ok: true, route: 'no-rule' });
    });

    it('does not apply limit when method does not match', async () => {
      const app = createTestApp([{ method: 'PUT', route: '/upload', limit: '1kb' }]);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(201);
    });

    it('normalizes routes without leading slash', async () => {
      const app = createTestApp([{ method: 'POST', route: 'upload', limit: '1kb' }]);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });
  });

  describe('empty rules', () => {
    it('passes through when no rules are configured', async () => {
      const app = createTestApp([]);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(50000) });

      expect(response.status).toBe(201);
    });

    it('passes through when rules array is undefined', async () => {
      const app = createTestApp(undefined as unknown as Array<{ method: string; route: string; limit: string }>);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(50000) });

      expect(response.status).toBe(201);
    });
  });

  describe('URL-encoded bodies', () => {
    it('enforces limit on URL-encoded bodies', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '1kb' }]);

      const response = await request(app)
        .post('/upload')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('payload=' + 'x'.repeat(2000));

      expect(response.status).toBe(413);
    });

    it('allows URL-encoded bodies within limit', async () => {
      const app = createTestApp([{ method: 'POST', route: '/upload', limit: '10kb' }]);

      const response = await request(app)
        .post('/upload')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('payload=hello');

      expect(response.status).toBe(201);
    });
  });

  describe('case insensitive method matching', () => {
    it('matches methods regardless of case', async () => {
      const app = createTestApp([{ method: 'post', route: '/upload', limit: '1kb' }]);

      const response = await request(app)
        .post('/upload')
        .send({ payload: 'x'.repeat(2000) });

      expect(response.status).toBe(413);
    });
  });
});
