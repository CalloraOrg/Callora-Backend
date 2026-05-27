/// <reference types="jest" />
import request from 'supertest';
import type { Server } from 'http';
import app, { createGracefulShutdownHandler, createInFlightDrainTracker } from './index.js';

jest.mock('./db/index.js', () => ({
  db: {},
  initializeDb: jest.fn(),
  schema: {},
}));
describe('Health API', () => {
  it('should return ok status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('graceful shutdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('closes server and database resources', async () => {
    const closeServer = jest.fn((callback: (err?: Error) => void) => callback());
    const closeDatabase = jest.fn(async () => Promise.resolve());
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const shutdown = createGracefulShutdownHandler({
      server: { close: closeServer } as unknown as Server,
      activeConnections: new Set(),
      closeDatabase,
      logger,
      timeoutMs: 50,
    });

    await expect(shutdown('SIGTERM')).resolves.toBe(0);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('stops subsystems and waits for in-flight work before closing database resources', async () => {
    let closeCallback: ((err?: Error) => void) | undefined;
    let resolveDrain: (() => void) | undefined;
    const closeServer = jest.fn((callback: (err?: Error) => void) => {
      closeCallback = callback;
    });
    const closeDatabase = jest.fn(async () => Promise.resolve());
    const beginShutdown = jest.fn();
    const awaitIdle = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDrain = resolve;
        }),
    );

    const shutdown = createGracefulShutdownHandler({
      server: { close: closeServer } as unknown as Server,
      activeConnections: new Set(),
      closeDatabase,
      timeoutMs: 50,
      subsystems: [{ name: 'jobs', beginShutdown, awaitIdle }],
    });

    const promise = shutdown('SIGTERM');
    await Promise.resolve();
    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(awaitIdle).toHaveBeenCalledTimes(1);
    expect(closeDatabase).not.toHaveBeenCalled();

    closeCallback?.();
    expect(closeDatabase).not.toHaveBeenCalled();

    resolveDrain?.();
    await expect(promise).resolves.toBe(0);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('destroys lingering sockets after the drain timeout', async () => {
    jest.useFakeTimers();

    const destroy = jest.fn();
    const socket = { destroy } as never;
    const closeServer = jest.fn((_callback: (err?: Error) => void) => {
      // Intentionally never closes to force timeout handling.
    });
    const closeDatabase = jest.fn(async () => Promise.resolve());

    const shutdown = createGracefulShutdownHandler({
      server: { close: closeServer } as unknown as Server,
      activeConnections: new Set([socket]),
      closeDatabase,
      timeoutMs: 25,
    });

    void shutdown('SIGTERM');
    jest.advanceTimersByTime(25);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('reuses in-flight shutdown promise on repeated signals', async () => {
    let closeCallback: ((err?: Error) => void) | undefined;
    const closeServer = jest.fn((callback: (err?: Error) => void) => {
      closeCallback = callback;
    });
    const closeDatabase = jest.fn(async () => Promise.resolve());

    const shutdown = createGracefulShutdownHandler({
      server: { close: closeServer } as unknown as Server,
      activeConnections: new Set(),
      closeDatabase,
      timeoutMs: 50,
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');

    expect(closeServer).toHaveBeenCalledTimes(1);
    closeCallback?.();

    await expect(first).resolves.toBe(0);
    await expect(second).resolves.toBe(0);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});

describe('proxy drain tracker', () => {
  it('waits for active proxy requests to finish before becoming idle', async () => {
    const tracker = createInFlightDrainTracker('gateway-proxy');
    const next = jest.fn();
    const listeners = new Map<string, () => void>();
    const res = {
      setHeader: jest.fn(),
      once: jest.fn((event: string, handler: () => void) => {
        listeners.set(event, handler);
        return res;
      }),
    } as any;

    tracker.middleware({} as any, res, next);
    tracker.subsystem.beginShutdown();
    const idlePromise = tracker.subsystem.awaitIdle();

    let settled = false;
    void idlePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    listeners.get('finish')?.();
    await expect(idlePromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});
