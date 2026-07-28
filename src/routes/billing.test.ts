import express from 'express';
import request from 'supertest';
import billingRouter from './billing.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { encodeCursor } from '../lib/cursorPagination.js';

function buildApp(pool: { query: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.locals.dbPool = pool;
  app.use('/api/billing', billingRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/billing', () => {
  it('returns paginated billing requests for the authenticated developer', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'req-2',
            request_id: 'request-2',
            developer_id: 'dev-1',
            api_id: 'api-2',
            endpoint_id: 'endpoint-2',
            api_key_id: 'key-2',
            amount_usdc: '4.00',
            created_at: new Date('2024-01-02T00:00:00.000Z'),
          },
          {
            id: 'req-1',
            request_id: 'request-1',
            developer_id: 'dev-1',
            api_id: 'api-1',
            endpoint_id: 'endpoint-1',
            api_key_id: 'key-1',
            amount_usdc: '2.00',
            created_at: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      }),
    };

    const app = buildApp(pool as unknown as { query: jest.Mock });
    const res = await request(app)
      .get('/api/billing?limit=1')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].requestId).toBe('request-2');
    expect(res.body.meta.hasMore).toBe(true);
    expect(res.body.meta.nextCursor).toBeTruthy();
  });

  it('rejects an invalid cursor', async () => {
    const app = buildApp({ query: jest.fn() } as unknown as { query: jest.Mock });
    const res = await request(app)
      .get('/api/billing?cursor=invalid-cursor')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
  });

  it('returns the next page when a valid cursor is supplied', async () => {
    const cursor = encodeCursor(new Date('2024-01-02T00:00:00.000Z'), 'req-2');
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };

    const app = buildApp(pool as unknown as { query: jest.Mock });
    const res = await request(app)
      .get(`/api/billing?limit=1&cursor=${encodeURIComponent(cursor)}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.hasMore).toBe(false);
  });

  it('supports ETag and returns 304 Not Modified', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'req-3',
            request_id: 'request-3',
            developer_id: 'dev-1',
            api_id: 'api-3',
            endpoint_id: 'endpoint-3',
            api_key_id: 'key-3',
            amount_usdc: '1.00',
            created_at: new Date('2024-01-03T00:00:00.000Z'),
          },
        ],
      }),
    };

    const app = buildApp(pool as unknown as { query: jest.Mock });

    // First request should return 200 and ETag
    const res1 = await request(app)
      .get('/api/billing?limit=1')
      .set('x-user-id', 'dev-1');

    expect(res1.status).toBe(200);
    expect(res1.headers.etag).toBeDefined();

    const etag = res1.headers.etag;

    // Second request with If-None-Match should return 304
    const res2 = await request(app)
      .get('/api/billing?limit=1')
      .set('x-user-id', 'dev-1')
      .set('If-None-Match', etag);

    expect(res2.status).toBe(304);
    expect(res2.body).toEqual({});
  });
});
