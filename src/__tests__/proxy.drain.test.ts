/**
 * Focused tests for graceful-shutdown drain behaviour on the /v1/call proxy
 * (issue #923).
 *
 * These tests verify:
 *  1. When drain mode is NOT active, requests proceed normally.
 *  2. When drain mode IS active, new requests are rejected immediately with
 *     503 Service Unavailable (Connection: close, Retry-After: 0).
 *  3. In-flight requests that arrived BEFORE drain mode began are allowed to
 *     complete normally; the tracker waits for them before resolving awaitIdle.
 *  4. The drain tracker isDraining() flag flips from false → true when
 *     beginShutdown() is called.
 *  5. End-to-end: the shutdown handler waits for active proxy requests to
 *     finish before calling closeDatabase.
 *
 * Test stack: Express + supertest (HTTP) + Jest. A lightweight mock upstream
 * server is used to exercise the full request flow.
 */

/// <reference types="jest" />

import express from 'express';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';

import { createProxyRouter } from '../routes/proxyRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { MockSorobanBilling } from '../services/billingService.js';
import { InMemoryRateLimiter } from '../services/rateLimiter.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { createInFlightDrainTracker, createGracefulShutdownHandler } from '../lifecycle/shutdown.js';
import { ApiKey, ApiRegistryEntry } from '../types/gateway.js';
import { resetAllMetrics } from '../metrics.js';
import request from 'supertest';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const TEST_API_KEY = 'drain-test-key';
const TEST_DEVELOPER_ID = 'dev_drain';
const TEST_API_ID = 'api_drain';
const TEST_API_SLUG = 'drain-test-api';

const apiKeys = new Map<string, ApiKey>([
  [TEST_API_KEY, { key: TEST_API_KEY, developerId: TEST_DEVELOPER_ID, apiId: TEST_API_ID }],
]);

// ─── Mock upstream ─────────────────────────────────────────────────────────────

let upstreamServer: Server;
let upstreamUrl: string;
let upstreamHandler: (req: express.Request, res: express.Response) => void;

function setUpstreamHandler(handler: (req: express.Request, res: express.Response) => void) {
  upstreamHandler = handler;
}

// ─── Helper: build a proxy app with optional drainState ───────────────────────

function buildProxyApp(options: {
  drainState?: { isDraining: () => boolean };
  billing?: MockSorobanBilling;
  usageStore?: InMemoryUsageStore;
}) {
  const billing = options.billing ?? new MockSorobanBilling({ [TEST_DEVELOPER_ID]: 1000 });
  const rateLimiter = new InMemoryRateLimiter(100, 60_000);
  const usageStore = options.usageStore ?? new InMemoryUsageStore();

  const registryEntry: ApiRegistryEntry = {
    id: TEST_API_ID,
    slug: TEST_API_SLUG,
    base_url: upstreamUrl,
    developerId: TEST_DEVELOPER_ID,
    endpoints: [{ endpointId: 'default', path: '*', priceUsdc: 1 }],
  };
  const registry = new InMemoryApiRegistry([registryEntry]);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  const proxyRouter = createProxyRouter({
    billing,
    rateLimiter,
    usageStore,
    registry,
    apiKeys,
    proxyConfig: { timeoutMs: 2000, allowedHosts: ['localhost'] },
    drainState: options.drainState,
  });

  app.use('/v1/call', proxyRouter);
  app.use(errorHandler);
  return { app, usageStore };
}

// ─── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    const upstream = express();
    upstream.use(express.json());
    upstream.all('*', (req, res) => upstreamHandler(req, res));
    upstreamServer = upstream.listen(0, () => {
      const addr = upstreamServer.address();
      if (addr && typeof addr === 'object') {
        upstreamUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });

  // Default upstream responds 200
  setUpstreamHandler((_req, res) => res.status(200).json({ ok: true }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

beforeEach(() => {
  resetAllMetrics();
  // Reset to default upstream handler
  setUpstreamHandler((_req, res) => res.status(200).json({ ok: true }));
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Proxy /v1/call — graceful shutdown drain (issue #923)', () => {

  // ── 1. Normal operation ──────────────────────────────────────────────────────

  describe('when drain is NOT active', () => {
    it('passes requests through to the upstream server', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => false } });

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it('operates normally without a drainState provided (backwards compat)', async () => {
      const { app } = buildProxyApp({});

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(200);
    });

    it('does NOT set Retry-After or Connection:close on normal responses', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => false } });

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(200);
      // Retry-After should be absent in normal mode
      expect(res.headers['retry-after']).toBeUndefined();
    });
  });

  // ── 2. Drain mode — new requests rejected ────────────────────────────────────

  describe('when drain IS active', () => {
    it('rejects new requests with 503 Service Unavailable', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => true } });

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(503);
    });

    it('includes Connection: close on the 503 rejection', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => true } });

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(503);
      expect(res.headers['connection']).toBe('close');
    });

    it('includes Retry-After: 0 on the 503 rejection', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => true } });

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('0');
    });

    it('returns a structured error envelope with SERVICE_UNAVAILABLE code', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => true } });

      const res = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(res.status).toBe(503);
      // The error handler wraps errors in a { success, error: { code, message }, ... } envelope
      expect(res.body).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
    });

    it('rejects POST requests during drain mode too', async () => {
      const { app } = buildProxyApp({ drainState: { isDraining: () => true } });

      const res = await request(app)
        .post(`/v1/call/${TEST_API_SLUG}/action`)
        .set('x-api-key', TEST_API_KEY)
        .send({ data: 'test' });

      expect(res.status).toBe(503);
    });

    it('does NOT forward the request to upstream during drain mode', async () => {
      let upstreamCalled = false;
      setUpstreamHandler((_req, res) => {
        upstreamCalled = true;
        res.status(200).json({ ok: true });
      });

      const { app } = buildProxyApp({ drainState: { isDraining: () => true } });

      await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      expect(upstreamCalled).toBe(false);
    });

    it('does NOT record usage for requests rejected during drain mode', async () => {
      const usageStore = new InMemoryUsageStore();
      const { app } = buildProxyApp({
        drainState: { isDraining: () => true },
        usageStore,
      });

      await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);

      // Give the event loop time for any async recording
      await new Promise((r) => setImmediate(r));

      const events = await usageStore.getEvents();
      expect(events).toHaveLength(0);
    });
  });

  // ── 3. In-flight tracker integration ─────────────────────────────────────────

  describe('createInFlightDrainTracker integration', () => {
    it('isDraining() returns false before beginShutdown', () => {
      const tracker = createInFlightDrainTracker('proxy-drain-test');
      expect(tracker.isDraining()).toBe(false);
    });

    it('isDraining() returns true after beginShutdown', () => {
      const tracker = createInFlightDrainTracker('proxy-drain-test');
      tracker.subsystem.beginShutdown();
      expect(tracker.isDraining()).toBe(true);
    });

    it('new requests are rejected with 503 once beginShutdown is called on the tracker', async () => {
      const drainTracker = createInFlightDrainTracker('proxy-drain-e2e');
      const { app } = buildProxyApp({ drainState: drainTracker });

      // Before shutdown: request succeeds
      const beforeRes = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);
      expect(beforeRes.status).toBe(200);

      // Begin shutdown
      drainTracker.subsystem.beginShutdown();

      // After shutdown: request is rejected
      const afterRes = await request(app)
        .get(`/v1/call/${TEST_API_SLUG}/ping`)
        .set('x-api-key', TEST_API_KEY);
      expect(afterRes.status).toBe(503);
    });

    it('tracks in-flight requests and resolves awaitIdle only after they complete', async () => {
      const tracker = createInFlightDrainTracker('proxy-inflight-test');
      const listeners = new Map<string, () => void>();

      const mockRes = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
          return mockRes;
        }),
      } as unknown as Response;

      // Simulate a request entering the middleware
      tracker.middleware({} as unknown as Request, mockRes, jest.fn());

      // Begin shutdown while the request is still in flight
      tracker.subsystem.beginShutdown();

      const idlePromise = tracker.subsystem.awaitIdle();
      let resolved = false;
      void idlePromise.then(() => { resolved = true; });

      // Should not yet be idle
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Simulate request completing
      listeners.get('finish')?.();
      await idlePromise;
      expect(resolved).toBe(true);
    });
  });

  // ── 4. Shutdown handler waits for proxy drain ─────────────────────────────────

  describe('graceful shutdown handler waits for active proxy requests', () => {
    it('closeDatabase is not called until in-flight proxy requests complete', async () => {
      const drainTracker = createInFlightDrainTracker('shutdown-proxy-drain');
      const listeners = new Map<string, () => void>();

      const mockRes = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
          return mockRes;
        }),
      } as unknown as Response;

      // Simulate one in-flight proxy request
      drainTracker.middleware({} as unknown as Request, mockRes, jest.fn());

      let serverCloseCallback: ((err?: Error) => void) | undefined;
      const closeServer = jest.fn((cb: (err?: Error) => void) => { serverCloseCallback = cb; });
      const closeDatabase = jest.fn(async () => Promise.resolve());

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as import('http').Server,
        activeConnections: new Set(),
        closeDatabase,
        timeoutMs: 500,
        subsystems: [drainTracker.subsystem],
      });

      const shutdownPromise = shutdown('SIGTERM');
      await Promise.resolve();

      // Database should NOT have been closed yet
      expect(closeDatabase).not.toHaveBeenCalled();

      // Close the HTTP server (no-op for our purposes, but required)
      serverCloseCallback?.();

      // Complete the in-flight request
      listeners.get('finish')?.();

      // Now the shutdown should complete and closeDatabase should be called
      const exitCode = await shutdownPromise;
      expect(exitCode).toBe(0);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    });

    it('forces exit after drain timeout, destroying lingering sockets', async () => {
      jest.useFakeTimers();

      const drainTracker = createInFlightDrainTracker('shutdown-timeout-test');
      const listeners = new Map<string, () => void>();

      const mockRes = {
        setHeader: jest.fn(),
        once: jest.fn((event: string, handler: () => void) => {
          listeners.set(event, handler);
          return mockRes;
        }),
      } as unknown as Response;

      // Simulate an in-flight request that never finishes
      drainTracker.middleware({} as unknown as Request, mockRes, jest.fn());

      const destroySpy = jest.fn();
      const mockSocket = { destroy: destroySpy } as never;

      const closeServer = jest.fn((_cb: (err?: Error) => void) => {
        // never calls back — simulates a hung server
      });
      const closeDatabase = jest.fn(async () => Promise.resolve());

      const shutdown = createGracefulShutdownHandler({
        server: { close: closeServer } as unknown as import('http').Server,
        activeConnections: new Set([mockSocket]),
        closeDatabase,
        timeoutMs: 100,
        subsystems: [drainTracker.subsystem],
      });

      void shutdown('SIGTERM');

      // Advance past the drain timeout
      jest.advanceTimersByTime(100);

      // The lingering socket should have been forcibly destroyed
      expect(destroySpy).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });
});
