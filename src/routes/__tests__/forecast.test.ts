import express from 'express';
import request from 'supertest';
import { createForecastRouter } from '../forecast.js';
import { errorHandler } from '../../middleware/errorHandler.js';

describe('/api/forecast', () => {
  it('should return 200 with forecast data', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));
    app.use(errorHandler);

    const res = await request(app).get('/api/forecast');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.forecast).toBeDefined();
    expect(Array.isArray(res.body.data.forecast)).toBe(true);
    expect(res.body.data.forecast.length).toBe(24);
    expect(res.body.data.generatedAt).toBeDefined();
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it('should return forecast points with timestamp and value', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    for (const point of res.body.data.forecast) {
      expect(point.timestamp).toBeDefined();
      expect(typeof point.timestamp).toBe('string');
      expect(point.value).toBeDefined();
      expect(typeof point.value).toBe('number');
    }
  });

  it('should return 504 when forecast calculation takes too long', async () => {
    const app = express();

    const router = createForecastRouter(1);
    router.get('/slow', (_req, res) => {
      const now = Date.now();
      while (Date.now() - now < 200) {
      }
      res.json({ ok: true });
    });
    app.use('/api/forecast', router);

    const res = await request(app).get('/api/forecast/slow');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
  });

  it('should generate 24 forecast points', async () => {
    const app = express();
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.body.data.forecast).toHaveLength(24);
  });

  it('should include requestId in response', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.id = 'test-request-id';
      next();
    });
    app.use('/api/forecast', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.body.requestId).toBe('test-request-id');
  });

  it('should expose forecast as sub-route of /api in the router', async () => {
    const app = express();
    app.use('/api', createForecastRouter(5_000));

    const res = await request(app).get('/api/forecast');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
