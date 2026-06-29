import express from 'express';
import { createUsageSseRouter, UsageSseBroadcaster } from './sse.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import type { AddressInfo } from 'node:net';

const USER_ID = 'user-1';

describe('GET /api/usage/sse', () => {
  it('returns 401 when the request is unauthenticated', async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/usage/sse', createUsageSseRouter());
    app.use(errorHandler);

    const server = app.listen(0);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/usage/sse`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('streams usage updates to the authenticated user', async () => {
    const broadcaster = new UsageSseBroadcaster();
    const app = express();
    app.use(requestIdMiddleware);
    app.use('/api/usage/sse', createUsageSseRouter({ broadcaster }));
    app.use(errorHandler);

    const server = app.listen(0);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/usage/sse`, {
        headers: { 'x-user-id': USER_ID },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-store');

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const initialChunk = await reader!.read();
      const initialText = new TextDecoder().decode(initialChunk.value ?? new Uint8Array());
      expect(initialText).toContain('event: connected');

      broadcaster.emitForUser(USER_ID, {
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
      });

      const nextChunk = await reader!.read();
      const nextText = new TextDecoder().decode(nextChunk.value ?? new Uint8Array());
      expect(nextText).toContain('event: usage');
      expect(nextText).toContain('"apiId":"api-1"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
