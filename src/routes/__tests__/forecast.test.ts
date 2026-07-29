/**
 * src/routes/__tests__/forecast.test.ts
 *
 * Legacy test file retained for regression coverage.
 * The main pagination-focused suite lives in src/routes/forecast.test.ts.
 */

import express from 'express';
import request from 'supertest';
import { createForecastRouter } from '../forecast.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { FORECAST_DEFAULT_LIMIT } from '../forecast.js';

describe('/api/forecast — basic route smoke tests', () => {
  it('should return 200 with the paginated envelope', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));
    app.use(errorHandler);

    const res = await request(app).get('/api/forecast');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    // New shape: items, total, and optional next_cursor
    expect(res.body.data.items).toBeDefined();
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(typeof res.body.data.total).toBe('number');
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it('items contain timestamp and value fields', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    for (const point of res.body.data.items) {
      expect(point.timestamp).toBeDefined();
      expect(typeof point.timestamp).toBe('string');
      expect(point.value).toBeDefined();
      expect(typeof point.value).toBe('number');
    }
  });

  it('returns 504 when forecast calculation takes too long', async () => {
    const app = express();

    const router = createForecastRouter(1);
    router.get('/slow', (_req, res) => {
      const now = Date.now();
      while (Date.now() - now < 200) {
        /* spin */
      }
      res.json({ ok: true });
    });
    app.use('/api/forecast', router);

    const res = await request(app).get('/api/forecast/slow');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
  });

  it('default page has FORECAST_DEFAULT_LIMIT items', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.body.data.items).toHaveLength(FORECAST_DEFAULT_LIMIT);
  });

  it('total equals 24 (full hourly forecast horizon)', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.body.data.total).toBe(24);
  });

  it('includes requestId in response', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.id = 'test-request-id';
      next();
    });
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.body.requestId).toBe('test-request-id');
  });

  it('mounts correctly as sub-route of /api', async () => {
    const app = express();
    app.use('/api', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
