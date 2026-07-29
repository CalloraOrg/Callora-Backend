/// <reference types="jest" />
import request from 'supertest';
import type { Server } from 'http';
import type { Request, Response } from 'express';
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
    } as unknown as Response;

    tracker.middleware({} as unknown as Request, res, next);
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

// ---------------------------------------------------------------------------
// refresh-token drain tracker
// ---------------------------------------------------------------------------
// These tests exercise every code path in createInFlightDrainTracker that is
// relevant to the /api/refresh-token SIGTERM drain feature (#903).
// They use createInFlightDrainTracker directly — the same function that is
// wired into the graceful-shutdown handler for the refresh-token subsystem —
// so the coverage applies to the production code path without needing a live
// HTTP server.
// ---------------------------------------------------------------------------

/** Helper: build a minimal mock Express response that records `once` listeners. */
function makeRes() {
  const listeners = new Map<string, () => void>();
  const res = {
    setHeader: jest.fn(),
    once: jest.fn((event: string, handler: () => void) => {
      listeners.set(event, handler);
      return res;
    }),
    emit: (event: string) => listeners.get(event)?.(),
  } as any;
  return { res, listeners };
}

describe('refresh-token drain tracker', () => {
  it('is immediately idle when no requests are in flight', async () => {
    const tracker = createInFlightDrainTracker('refresh-token');

    tracker.subsystem.beginShutdown();

    // awaitIdle must resolve without any finish/close events.
    await expect(tracker.subsystem.awaitIdle()).resolves.toBeUndefined();
  });

  it('resolves awaitIdle once the single in-flight request finishes', async () => {
    const tracker = createInFlightDrainTracker('refresh-token');
    const next = jest.fn();
    const { res, listeners } = makeRes();

    tracker.middleware({} as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    tracker.subsystem.beginShutdown();
    const idlePromise = tracker.subsystem.awaitIdle();

    let settled = false;
    void idlePromise.then(() => { settled = true; });
    await Promise.resolve();

    // Still waiting — request has not finished yet.
    expect(settled).toBe(false);

    // Simulate the response finishing.
    listeners.get('finish')?.();

    await expect(idlePromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('resolves awaitIdle via the close event when finish never fires', async () => {
    const tracker = createInFlightDrainTracker('refresh-token');
    const next = jest.fn();
    const { res, listeners } = makeRes();

    tracker.middleware({} as any, res, next);
    tracker.subsystem.beginShutdown();

    const idlePromise = tracker.subsystem.awaitIdle();
    let settled = false;
    void idlePromise.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);

    // Simulate socket close without a finish event.
    listeners.get('close')?.();

    await expect(idlePromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('does not double-decrement when both finish and close fire for one request', async () => {
    // Regression guard: the settled flag in the middleware ensures the active
    // counter is decremented exactly once even if both events fire.
    const tracker = createInFlightDrainTracker('refresh-token');
    const next = jest.fn();

    // Dispatch two requests so we can verify the counter lands on zero, not
    // below zero (which would leave awaitIdle hanging forever if a third
    // request came in after the double-decrement).
    const { res: res1, listeners: l1 } = makeRes();
    const { res: res2, listeners: l2 } = makeRes();

    tracker.middleware({} as any, res1, next);
    tracker.middleware({} as any, res2, next);

    tracker.subsystem.beginShutdown();
    const idlePromise = tracker.subsystem.awaitIdle();

    // Fire both events for request 1 — should only decrement once.
    l1.get('finish')?.();
    l1.get('close')?.();

    // Still one request in flight.
    let settled = false;
    void idlePromise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Finish request 2 — now idle.
    l2.get('finish')?.();
    await expect(idlePromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('waits for all concurrent in-flight requests before becoming idle', async () => {
    const tracker = createInFlightDrainTracker('refresh-token');
    const next = jest.fn();

    const { res: res1, listeners: l1 } = makeRes();
    const { res: res2, listeners: l2 } = makeRes();
    const { res: res3, listeners: l3 } = makeRes();

    tracker.middleware({} as any, res1, next);
    tracker.middleware({} as any, res2, next);
    tracker.middleware({} as any, res3, next);
    expect(next).toHaveBeenCalledTimes(3);

    tracker.subsystem.beginShutdown();
    const idlePromise = tracker.subsystem.awaitIdle();

    let settled = false;
    void idlePromise.then(() => { settled = true; });
    await Promise.resolve();

    l1.get('finish')?.();
    await Promise.resolve();
    expect(settled).toBe(false);   // still 2 in flight

    l2.get('finish')?.();
    await Promise.resolve();
    expect(settled).toBe(false);   // still 1 in flight

    l3.get('finish')?.();
    await expect(idlePromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('sets Connection: close on responses received after beginShutdown', () => {
    const tracker = createInFlightDrainTracker('refresh-token');
    const next = jest.fn();
    const { res: resBefore } = makeRes();
    const { res: resAfter } = makeRes();

    // Request arriving BEFORE shutdown starts — no Connection: close.
    tracker.middleware({} as any, resBefore, next);
    expect(resBefore.setHeader).not.toHaveBeenCalledWith('Connection', 'close');

    // Signal shutdown.
    tracker.subsystem.beginShutdown();

    // Request arriving AFTER shutdown starts — must get Connection: close.
    tracker.middleware({} as any, resAfter, next);
    expect(resAfter.setHeader).toHaveBeenCalledWith('Connection', 'close');
  });

  it('resolves multiple awaitIdle callers once all requests finish', async () => {
    const tracker = createInFlightDrainTracker('refresh-token');
    const next = jest.fn();
    const { res, listeners } = makeRes();

    tracker.middleware({} as any, res, next);
    tracker.subsystem.beginShutdown();

    // Two independent callers waiting for idle (e.g. shutdown handler + test).
    const idle1 = tracker.subsystem.awaitIdle();
    const idle2 = tracker.subsystem.awaitIdle();

    listeners.get('finish')?.();

    await expect(Promise.all([idle1, idle2])).resolves.toEqual([undefined, undefined]);
  });

  it('exposes the subsystem name that was passed to the factory', () => {
    const tracker = createInFlightDrainTracker('refresh-token');
    expect(tracker.subsystem.name).toBe('refresh-token');
  });
});
