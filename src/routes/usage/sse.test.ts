import express from 'express';
import request from 'supertest';
import { createUsageSseRouter, defaultUsageSseBroadcaster } from './sse.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';

const USER_ID = 'user-1';

describe('GET /api/usage/sse', () => {
  afterEach(() => {
    defaultUsageSseBroadcaster.clear();
  });

  it('returns 401 when the request is unauthenticated', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/usage/sse', createUsageSseRouter());
    app.use(errorHandler);

    const response = await request(app).get('/api/usage/sse');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('streams usage updates to the authenticated user', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/usage/sse', createUsageSseRouter());
    app.use(errorHandler);

    const emittedEvent = {
      id: 'evt-1',
      requestId: 'req-1',
      apiKey: 'key-1',
      apiKeyId: 'key-id-1',
      apiId: 'api-1',
      endpointId: 'endpoint-1',
      userId: USER_ID,
      amountUsdc: 1,
      statusCode: 200,
      timestamp: '2026-06-28T12:00:00.000Z',
    };

    const received = await new Promise<string>((resolve, reject) => {
      let seen = '';
      let emitted = false;

      const streamRequest = request(app)
        .get('/api/usage/sse')
        .set('x-user-id', USER_ID)
        .buffer(false)
        .parse((res, callback) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            seen += chunk;

            if (!emitted && seen.includes('event: connected')) {
              emitted = true;
              defaultUsageSseBroadcaster.emitForUser(USER_ID, emittedEvent);
            }

            if (seen.includes('"apiId":"api-1"')) {
              streamRequest.abort();
              resolve(seen);
            }
          });
          res.on('error', reject);
          callback(null, seen);
        });

      streamRequest.end((error) => {
        if (error && !seen.includes('event: usage')) {
          reject(error);
        }
      });
    });

    expect(received).toContain('event: connected');
    expect(received).toContain('event: usage');
    expect(received).toContain('id: evt-1');
    expect(received).toContain('"apiId":"api-1"');
  });
});
