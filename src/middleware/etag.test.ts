import request from 'supertest';
import express from 'express';
import { etagMiddleware, generateETag } from './etag.js';

describe('etagMiddleware', () => {
  test('should set ETag header and return 200 for a GET request', async () => {
    const app = express();
    app.get('/test', etagMiddleware, (req, res) => {
      res.json({ message: 'hello world' });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).toMatch(/^W\/"/);
    expect(res.body).toEqual({ message: 'hello world' });
  });

  test('should return 304 Not Modified when If-None-Match matches ETag', async () => {
    const app = express();
    app.get('/test', etagMiddleware, (req, res) => {
      res.json({ message: 'hello world' });
    });

    const res1 = await request(app).get('/test');
    const etag = res1.headers.etag;
    expect(etag).toBeDefined();

    const res2 = await request(app)
      .get('/test')
      .set('If-None-Match', etag);

    expect(res2.status).toBe(304);
    expect(res2.text).toBe('');
  });

  test('should return 304 Not Modified when If-None-Match matches weak ETag without W/', async () => {
    const app = express();
    app.get('/test', etagMiddleware, (req, res) => {
      res.json({ message: 'hello world' });
    });

    const res1 = await request(app).get('/test');
    const etag = res1.headers.etag;
    expect(etag).toBeDefined();
    const rawHash = etag.replace('W/', '');

    const res2 = await request(app)
      .get('/test')
      .set('If-None-Match', rawHash);

    expect(res2.status).toBe(304);
    expect(res2.text).toBe('');
  });

  test('should return 200 when If-None-Match does not match ETag', async () => {
    const app = express();
    app.get('/test', etagMiddleware, (req, res) => {
      res.json({ message: 'hello world' });
    });

    const res = await request(app)
      .get('/test')
      .set('If-None-Match', 'W/"different-hash"');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hello world' });
  });

  test('should not set ETag for non-GET/HEAD requests', async () => {
    const app = express();
    app.use(express.json());
    app.post('/test', etagMiddleware, (req, res) => {
      res.json({ message: 'hello world' });
    });

    const res = await request(app).post('/test').send({});
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });
});
