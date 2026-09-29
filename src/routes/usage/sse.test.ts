import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import {
  UsageSseBroadcaster,
  createUsageSseRouter,
  defaultUsageSseBroadcaster,
  type UsageSseEventPayload,
} from './sse.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { logger } from '../../logger.js';

const USER_A = 'user-1';
const USER_B = 'user-2';

const buildEvent = (
  userId: string,
  overrides: Partial<UsageSseEventPayload> = {},
): UsageSseEventPayload => ({
  id: 'evt-1',
  requestId: 'req-1',
  apiKey: 'key-1',
  apiKeyId: 'key-id-1',
  apiId: 'api-1',
  endpointId: 'endpoint-1',
  userId,
  amountUsdc: 1,
  statusCode: 200,
  timestamp: '2026-06-28T12:00:00.000Z',
  ...overrides,
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (predicate: () => boolean, description: string, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await delay(10);
  }
};

/** Broadcaster that records how many times a stream actually unsubscribed. */
class CountingUsageSseBroadcaster extends UsageSseBroadcaster {
  unsubscribeCalls = 0;

  override subscribe(
    userId: string,
    listener: (event: UsageSseEventPayload) => void,
  ): () => void {
    const unsubscribe = super.subscribe(userId, listener);
    return () => {
      this.unsubscribeCalls += 1;
      unsubscribe();
    };
  }
}

interface UsageSseTestApp {
  app: Express;
  broadcaster: CountingUsageSseBroadcaster;
  serverRequests: Request[];
}

const createTestApp = (): UsageSseTestApp => {
  const broadcaster = new CountingUsageSseBroadcaster();
  const serverRequests: Request[] = [];
  const app = express();

  app.use(requestIdMiddleware);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    serverRequests.push(req);
    next();
  });
  app.use('/api/usage/sse', createUsageSseRouter({ broadcaster }));
  app.use(errorHandler);

  return { app, broadcaster, serverRequests };
};

interface SseStream {
  output: () => string;
  connected: Promise<void>;
  abort: () => void;
}

const openStreams: SseStream[] = [];

/**
 * Opens a streaming `GET /api/usage/sse` request that stays open until aborted,
 * mirroring how a browser `EventSource` behaves.
 */
const openSseStream = (app: Express, userId: string): SseStream => {
  let received = '';
  let announceConnected: () => void = () => undefined;
  const connected = new Promise<void>((resolve) => {
    announceConnected = resolve;
  });
  let connectedSeen = false;

  const stream = request(app)
    .get('/api/usage/sse')
    .set('x-user-id', userId)
    .buffer(false)
    .parse((res, callback) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        received += chunk;

        if (!connectedSeen && received.includes('event: connected')) {
          connectedSeen = true;
          announceConnected();
        }
      });
      res.on('error', () => {
        // Expected when the stream is aborted during teardown.
      });
      callback(null, received);
    });

  // Registering listeners keeps the abort error from surfacing as an
  // unhandled 'error' event once the test tears the stream down.
  stream.on('error', () => undefined);
  stream.end(() => undefined);

  const handle: SseStream = {
    output: () => received,
    connected,
    abort: () => stream.abort(),
  };
  openStreams.push(handle);

  return handle;
};

describe('UsageSseBroadcaster', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('never dispatches one user\'s event to another user\'s listeners', () => {
    const broadcaster = new UsageSseBroadcaster();
    const receivedByA: string[] = [];
    const receivedByB: string[] = [];

    broadcaster.subscribe(USER_A, (event) => receivedByA.push(event.id));
    broadcaster.subscribe(USER_B, (event) => receivedByB.push(event.id));

    expect(broadcaster.listenerCount(USER_A)).toBe(1);
    expect(broadcaster.listenerCount(USER_B)).toBe(1);
    expect(broadcaster.trackedUserCount()).toBe(2);

    broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-a' }));

    expect(receivedByA).toEqual(['evt-a']);
    expect(receivedByB).toEqual([]);

    broadcaster.emitForUser(USER_B, buildEvent(USER_B, { id: 'evt-b' }));

    expect(receivedByA).toEqual(['evt-a']);
    expect(receivedByB).toEqual(['evt-b']);
  });

  it('fans a user\'s event out to every stream that user has open', () => {
    const broadcaster = new UsageSseBroadcaster();
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = broadcaster.subscribe(USER_A, (event) => first.push(event.id));
    const unsubscribeSecond = broadcaster.subscribe(USER_A, (event) => second.push(event.id));

    expect(broadcaster.listenerCount(USER_A)).toBe(2);
    expect(broadcaster.trackedUserCount()).toBe(1);

    broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-1' }));
    expect(first).toEqual(['evt-1']);
    expect(second).toEqual(['evt-1']);

    unsubscribeFirst();
    expect(broadcaster.listenerCount(USER_A)).toBe(1);
    expect(broadcaster.trackedUserCount()).toBe(1);

    broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-2' }));
    expect(first).toEqual(['evt-1']);
    expect(second).toEqual(['evt-1', 'evt-2']);

    unsubscribeSecond();
    expect(broadcaster.listenerCount(USER_A)).toBe(0);
    expect(broadcaster.trackedUserCount()).toBe(0);
  });

  it('logs a throwing listener and keeps delivering to the healthy ones', () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const broadcaster = new UsageSseBroadcaster();
    const healthyBefore: string[] = [];
    const healthyAfter: string[] = [];
    const otherUser: string[] = [];

    broadcaster.subscribe(USER_A, () => {
      throw new Error('socket write failed');
    });
    broadcaster.subscribe(USER_A, (event) => healthyBefore.push(event.id));
    broadcaster.subscribe(USER_A, (event) => healthyAfter.push(event.id));
    broadcaster.subscribe(USER_B, (event) => otherUser.push(event.id));

    expect(() => broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-a' }))).not.toThrow();

    expect(healthyBefore).toEqual(['evt-a']);
    expect(healthyAfter).toEqual(['evt-a']);
    expect(otherUser).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[usage.sse] failed to dispatch event',
      expect.objectContaining({ userId: USER_A, error: expect.any(Error) }),
    );
    // Dispatch failures must not mutate the registry; disconnect handling owns removal.
    expect(broadcaster.listenerCount(USER_A)).toBe(3);
  });

  it('unsubscribes exactly once and never evicts a newer listener for the same user', () => {
    const broadcaster = new UsageSseBroadcaster();
    const first: string[] = [];
    const second: string[] = [];

    const unsubscribeFirst = broadcaster.subscribe(USER_A, (event) => first.push(event.id));
    unsubscribeFirst();
    expect(broadcaster.trackedUserCount()).toBe(0);

    const unsubscribeSecond = broadcaster.subscribe(USER_A, (event) => second.push(event.id));

    // A duplicate or late disconnect signal from the old stream must not evict
    // the live stream that registered for the same user afterwards.
    unsubscribeFirst();
    unsubscribeFirst();
    expect(broadcaster.listenerCount(USER_A)).toBe(1);
    expect(broadcaster.trackedUserCount()).toBe(1);

    broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-1' }));
    expect(first).toEqual([]);
    expect(second).toEqual(['evt-1']);

    unsubscribeSecond();
    unsubscribeSecond();
    expect(broadcaster.listenerCount(USER_A)).toBe(0);
    expect(broadcaster.trackedUserCount()).toBe(0);
  });

  it('is a no-op when emitting for a user without listeners', () => {
    const broadcaster = new UsageSseBroadcaster();
    const received: string[] = [];
    const unsubscribe = broadcaster.subscribe(USER_A, (event) => received.push(event.id));

    unsubscribe();

    expect(() => broadcaster.emitForUser(USER_A, buildEvent(USER_A))).not.toThrow();
    expect(() => broadcaster.emitForUser(USER_B, buildEvent(USER_B))).not.toThrow();
    expect(received).toEqual([]);
    expect(broadcaster.listenerCount(USER_A)).toBe(0);
    expect(broadcaster.listenerCount(USER_B)).toBe(0);
    expect(broadcaster.trackedUserCount()).toBe(0);
  });
});

describe('GET /api/usage/sse', () => {
  beforeEach(() => {
    // The router logs one connect + one disconnect line per stream.
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    while (openStreams.length > 0) {
      openStreams.pop()?.abort();
    }
    defaultUsageSseBroadcaster.clear();
    jest.restoreAllMocks();
    await delay(10);
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
      userId: USER_A,
      amountUsdc: 1,
      statusCode: 200,
      timestamp: '2026-06-28T12:00:00.000Z',
    };

    const received = await new Promise<string>((resolve, reject) => {
      let seen = '';
      let emitted = false;

      const streamRequest = request(app)
        .get('/api/usage/sse')
        .set('x-user-id', USER_A)
        .buffer(false)
        .parse((res, callback) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            seen += chunk;

            if (!emitted && seen.includes('event: connected')) {
              emitted = true;
              defaultUsageSseBroadcaster.emitForUser(USER_A, emittedEvent);
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

  it('does not deliver one user\'s events to another user\'s stream', async () => {
    const { app, broadcaster } = createTestApp();

    const streamA = openSseStream(app, USER_A);
    const streamB = openSseStream(app, USER_B);
    await Promise.all([streamA.connected, streamB.connected]);

    expect(broadcaster.listenerCount(USER_A)).toBe(1);
    expect(broadcaster.listenerCount(USER_B)).toBe(1);
    expect(broadcaster.trackedUserCount()).toBe(2);

    broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-a', apiId: 'api-a' }));
    await waitFor(() => streamA.output().includes('evt-a'), 'user-1 usage event');
    await delay(50);

    expect(streamA.output()).toContain('event: usage');
    expect(streamA.output()).toContain('"apiId":"api-a"');
    expect(streamB.output()).not.toContain('event: usage');
    expect(streamB.output()).not.toContain('evt-a');
    expect(streamB.output()).not.toContain('"apiId":"api-a"');

    broadcaster.emitForUser(USER_B, buildEvent(USER_B, { id: 'evt-b', apiId: 'api-b' }));
    await waitFor(() => streamB.output().includes('evt-b'), 'user-2 usage event');
    await delay(50);

    expect(streamB.output()).toContain('"apiId":"api-b"');
    expect(streamA.output()).not.toContain('evt-b');
    expect(streamA.output()).not.toContain('"apiId":"api-b"');
  });

  it('drops every listener once the client disconnects', async () => {
    const { app, broadcaster } = createTestApp();

    const streamA = openSseStream(app, USER_A);
    const streamB = openSseStream(app, USER_B);
    await Promise.all([streamA.connected, streamB.connected]);
    expect(broadcaster.trackedUserCount()).toBe(2);

    streamA.abort();
    streamB.abort();
    await waitFor(() => broadcaster.trackedUserCount() === 0, 'the listener map to drain');

    expect(broadcaster.listenerCount(USER_A)).toBe(0);
    expect(broadcaster.listenerCount(USER_B)).toBe(0);
    // A single abort fires `aborted`, response `close` and request `close`;
    // the stream must still be removed exactly once.
    expect(broadcaster.unsubscribeCalls).toBe(2);
  });

  it('keeps serving the remaining stream when one of a user\'s streams disconnects', async () => {
    const { app, broadcaster } = createTestApp();

    const first = openSseStream(app, USER_A);
    const second = openSseStream(app, USER_A);
    await Promise.all([first.connected, second.connected]);
    expect(broadcaster.listenerCount(USER_A)).toBe(2);

    first.abort();
    await waitFor(() => broadcaster.listenerCount(USER_A) === 1, 'the closed stream to be removed');

    broadcaster.emitForUser(USER_A, buildEvent(USER_A, { id: 'evt-after-close' }));
    await waitFor(() => second.output().includes('evt-after-close'), 'usage event on the live stream');

    expect(first.output()).not.toContain('evt-after-close');
    expect(broadcaster.trackedUserCount()).toBe(1);
  });

  it('unsubscribes exactly once on the aborted path', async () => {
    const { app, broadcaster, serverRequests } = createTestApp();

    const stream = openSseStream(app, USER_A);
    await stream.connected;
    expect(broadcaster.listenerCount(USER_A)).toBe(1);

    serverRequests[0].emit('aborted');
    expect(broadcaster.unsubscribeCalls).toBe(1);
    expect(broadcaster.listenerCount(USER_A)).toBe(0);
    expect(broadcaster.trackedUserCount()).toBe(0);

    stream.abort();
    await delay(50);
    expect(broadcaster.unsubscribeCalls).toBe(1);
  });

  it('unsubscribes exactly once on the close path', async () => {
    const { app, broadcaster, serverRequests } = createTestApp();

    const stream = openSseStream(app, USER_A);
    await stream.connected;
    expect(broadcaster.listenerCount(USER_A)).toBe(1);

    serverRequests[0].emit('close');
    expect(broadcaster.unsubscribeCalls).toBe(1);
    expect(broadcaster.listenerCount(USER_A)).toBe(0);
    expect(broadcaster.trackedUserCount()).toBe(0);

    stream.abort();
    await delay(50);
    expect(broadcaster.unsubscribeCalls).toBe(1);
  });

  it('unsubscribes exactly once when both close and aborted are emitted', async () => {
    const { app, broadcaster, serverRequests } = createTestApp();

    const stream = openSseStream(app, USER_A);
    await stream.connected;

    serverRequests[0].emit('aborted');
    serverRequests[0].emit('close');
    expect(broadcaster.unsubscribeCalls).toBe(1);

    stream.abort();
    await delay(50);
    expect(broadcaster.unsubscribeCalls).toBe(1);
    expect(broadcaster.trackedUserCount()).toBe(0);
  });
});
