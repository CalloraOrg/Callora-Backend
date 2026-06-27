jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { createUsageSseRouter } from './sse.js';
import type { CalloraEventListener } from '../../events/event.emitter.js';
import type { NewApiCallData } from '../../webhooks/webhook.types.js';
import { errorHandler } from '../../middleware/errorHandler.js';

const SSE_PATH = '/usage/sse';
const HEARTBEAT_MS = 50;

class TestUsageEventBus {
  private readonly listeners = new Set<CalloraEventListener<'new_api_call'>>();

  on(event: 'new_api_call', listener: CalloraEventListener<'new_api_call'>) {
    expect(event).toBe('new_api_call');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(developerId: string, data: NewApiCallData) {
    for (const listener of this.listeners) {
      listener(developerId, data);
    }
  }

  listenerCount() {
    return this.listeners.size;
  }
}

async function startSseServer(
  headers: Record<string, string> = {},
  options: { emitRequestError?: Error; emitResponseError?: Error } = {},
): Promise<{ url: string; chunks: string[]; events: TestUsageEventBus; close: () => Promise<void> }> {
  const events = new TestUsageEventBus();
  const app = express();
  app.use((req, res, next) => {
    if (options.emitRequestError) {
      setImmediate(() => req.emit('error', options.emitRequestError));
    }
    if (options.emitResponseError) {
      setImmediate(() => res.emit('error', options.emitResponseError));
    }
    next();
  });
  app.use(SSE_PATH, createUsageSseRouter({ events, heartbeatIntervalMs: HEARTBEAT_MS }));
  app.use(errorHandler);

  const server = app.listen(0) as http.Server;
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const url = `http://localhost:${port}${SSE_PATH}`;

  const chunks: string[] = [];

  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push(chunk));
      resolve({
        url,
        chunks,
        events,
        close: () =>
          new Promise((resolveClose) => {
            req.destroy();
            server.close(() => resolveClose());
          }),
      });
    });

    req.on('error', reject);
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createUsageSseRouter', () => {
  it('requires authentication', async () => {
    const app = express();
    app.use(SSE_PATH, createUsageSseRouter());
    app.use(errorHandler);

    const res = await request(app).get(SSE_PATH);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns SSE headers and a connected event', async () => {
    const { chunks, close } = await startSseServer({ 'x-user-id': 'dev-1' });
    await wait(HEARTBEAT_MS + 20);
    await close();

    const text = chunks.join('');
    expect(text).toContain('event: connected');
    expect(text).toContain('"stream":"usage"');
    expect(text).toContain('"developerId":"dev-1"');
  });

  it('streams new_api_call events for the authenticated developer', async () => {
    const { chunks, events, close } = await startSseServer({ 'x-user-id': 'dev-1' });
    await wait(HEARTBEAT_MS);

    events.emit('dev-1', {
      apiId: 'api-1',
      endpoint: '/v1/data',
      method: 'GET',
      statusCode: 200,
      latencyMs: 12,
      creditsUsed: 1,
    });

    await wait(HEARTBEAT_MS + 20);
    await close();

    const text = chunks.join('');
    expect(text).toContain('event: new_api_call');
    expect(text).toContain('"apiId":"api-1"');
    expect(text).toContain('"endpoint":"/v1/data"');
  });

  it('does not stream events belonging to a different developer', async () => {
    const { chunks, events, close } = await startSseServer({ 'x-user-id': 'dev-1' });
    await wait(HEARTBEAT_MS);

    events.emit('dev-2', {
      apiId: 'api-2',
      endpoint: '/v1/other',
      method: 'POST',
      statusCode: 201,
      latencyMs: 5,
      creditsUsed: 2,
    });

    await wait(HEARTBEAT_MS + 20);
    await close();

    const text = chunks.join('');
    expect(text).toContain('event: connected');
    expect(text).not.toContain('"apiId":"api-2"');
    expect(text).not.toContain('"/v1/other"');
  });

  it('sends periodic heartbeat comments', async () => {
    const { chunks, close } = await startSseServer({ 'x-user-id': 'dev-1' });
    await wait(HEARTBEAT_MS * 2 + 30);
    await close();

    const text = chunks.join('');
    const heartbeatCount = (text.match(/: heartbeat/g) ?? []).length;
    expect(heartbeatCount).toBeGreaterThanOrEqual(1);
  });

  it('cleans up the listener when the client disconnects', async () => {
    const { events, close } = await startSseServer({ 'x-user-id': 'dev-1' });
    expect(events.listenerCount()).toBeGreaterThan(0);

    await close();
    await wait(HEARTBEAT_MS + 20);

    expect(events.listenerCount()).toBe(0);
  });

  it('cleans up the listener after unexpected request errors', async () => {
    const { events, close } = await startSseServer(
      { 'x-user-id': 'dev-1' },
      { emitRequestError: new Error('socket failure') },
    );

    await wait(HEARTBEAT_MS + 20);
    expect(events.listenerCount()).toBe(0);
    await close();
  });

  it('cleans up the listener after response errors', async () => {
    const { events, close } = await startSseServer(
      { 'x-user-id': 'dev-1' },
      { emitResponseError: new Error('response failure') },
    );

    await wait(HEARTBEAT_MS + 20);
    expect(events.listenerCount()).toBe(0);
    await close();
  });
});
