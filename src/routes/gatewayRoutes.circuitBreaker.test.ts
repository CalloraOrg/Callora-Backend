/**
 * Tests for issue #924 — per-endpoint circuit breaker on /api/gateway
 *
 * Verifies that:
 * - Each apiId gets an isolated circuit breaker (failures on api-A don't trip api-B)
 * - A tripped breaker returns 503 before billing is charged
 * - Upstream errors trip the breaker after failureThreshold failures
 * - The breaker returns 503 when in OPEN state (fast-fail)
 * - The HALF_OPEN state allows a single probe and re-closes on success
 * - Billing is never charged when the circuit is OPEN
 */

import express from 'express';
import request from 'supertest';
import { createGatewayRouter, clearHealthCache } from './gatewayRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import {
  BreakerRegistry,
  CircuitBreakerState,
} from '../lib/circuitBreaker.js';
import type { GatewayDeps } from '../types/gateway.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_ID_A = 'api-cb-a';
const API_ID_B = 'api-cb-b';
// Keys must be ≥ 16 chars for prefix-based lookup in gatewayRoutes
const API_KEY_A = 'circuit-key-a-xxxxxyz';
const API_KEY_B = 'circuit-key-b-xxxxxyz';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiKeys() {
  return new Map([
    [API_KEY_A, { key: 'ka', apiId: API_ID_A, developerId: 'devA' }],
    [API_KEY_B, { key: 'kb', apiId: API_ID_B, developerId: 'devB' }],
  ]);
}

function buildApp(
  breakerRegistry: BreakerRegistry,
  billingMock: jest.Mock = jest.fn().mockResolvedValue({ success: true, balance: 100 }),
): express.Application {
  const deps: GatewayDeps = {
    billing: {
      deductCredit: billingMock,
      checkBalance: async () => 100,
    },
    rateLimiter: { check: async () => ({ allowed: true }) },
    usageStore: {
      record: jest.fn().mockResolvedValue(true),
      hasEvent: jest.fn(),
      getEvents: jest.fn(),
      getUnsettledEvents: jest.fn(),
      markAsSettled: jest.fn(),
    },
    upstreamUrl: 'http://example.internal',
    apiKeys: makeApiKeys(),
    breakerRegistry,
  };

  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/gateway', createGatewayRouter(deps));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gateway per-endpoint circuit breaker (#924)', () => {
  let savedFetch: typeof global.fetch;

  beforeAll(() => {
    savedFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
    clearHealthCache();
    jest.restoreAllMocks();
  });

  // ── Happy-path: breaker stays CLOSED on success ─────────────────────────

  it('forwards requests to upstream when the breaker is CLOSED', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ hello: 'world' }),
    } as Response);

    const registry = new BreakerRegistry();
    const app = buildApp(registry);

    const res = await request(app)
      .get(`/api/gateway/${API_ID_A}`)
      .set('x-api-key', API_KEY_A);

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // ── Manual trip → 503, no upstream call, no billing ─────────────────────

  it('returns 503 and skips upstream + billing when breaker is manually tripped', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{}',
    } as Response);

    const registry = new BreakerRegistry();
    // Create breaker with very long cooldown so it stays OPEN
    const breaker = registry.getOrCreate(API_ID_A, {
      failureThreshold: 1,
      cooldownMs: 999_999,
    });
    await breaker.trip(API_ID_A);

    const billingMock = jest.fn().mockResolvedValue({ success: true, balance: 100 });
    const app = buildApp(registry, billingMock);

    const res = await request(app)
      .get(`/api/gateway/${API_ID_A}`)
      .set('x-api-key', API_KEY_A);

    expect(res.status).toBe(503);

    // Upstream must NOT be called
    expect(global.fetch).not.toHaveBeenCalled();
    // Billing must NOT be charged
    expect(billingMock).not.toHaveBeenCalled();
  });

  // ── 503 response has the correct error envelope ──────────────────────────

  it('503 response has the standard SERVICE_UNAVAILABLE error code', async () => {
    const registry = new BreakerRegistry();
    const breaker = registry.getOrCreate(API_ID_A, {
      failureThreshold: 1,
      cooldownMs: 999_999,
    });
    await breaker.trip(API_ID_A);

    const app = buildApp(registry);

    const res = await request(app)
      .get(`/api/gateway/${API_ID_A}`)
      .set('x-api-key', API_KEY_A);

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // Support both flat {code, message} and nested {error: {code, message}}
    const code: string = res.body.error?.code ?? res.body.code;
    const message: string = res.body.error?.message ?? res.body.message;
    expect(code).toBe('SERVICE_UNAVAILABLE');
    expect(message).toMatch(/circuit breaker/i);
  });

  // ── Upstream failures trip the breaker ───────────────────────────────────

  it('trips the breaker after failureThreshold upstream errors', async () => {
    const FAILURE_THRESHOLD = 3;

    // Upstream rejects every time (TypeError with network error)
    global.fetch = jest.fn().mockRejectedValue(
      new TypeError('fetch failed'),
    );

    const registry = new BreakerRegistry();
    // Pre-create breaker with known config
    registry.getOrCreate(API_ID_A, {
      failureThreshold: FAILURE_THRESHOLD,
      cooldownMs: 999_999,
    });
    const billingMock = jest.fn().mockResolvedValue({ success: true, balance: 100 });
    const app = buildApp(registry, billingMock);

    // Fire FAILURE_THRESHOLD requests — each gets a 502
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      const res = await request(app)
        .get(`/api/gateway/${API_ID_A}`)
        .set('x-api-key', API_KEY_A);
      expect([502, 503]).toContain(res.status);
    }

    // After threshold failures the breaker should be OPEN
    const state = await registry.getState(API_ID_A);
    expect(state).toBe(CircuitBreakerState.OPEN);
  });

  // ── Next request after trip returns 503, no billing ──────────────────────

  it('returns 503 and does not call billing once breaker is OPEN', async () => {
    const FAILURE_THRESHOLD = 2;

    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

    const registry = new BreakerRegistry();
    registry.getOrCreate(API_ID_A, {
      failureThreshold: FAILURE_THRESHOLD,
      cooldownMs: 999_999,
    });
    const billingMock = jest.fn().mockResolvedValue({ success: true, balance: 100 });
    const app = buildApp(registry, billingMock);

    // Exhaust the threshold
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await request(app)
        .get(`/api/gateway/${API_ID_A}`)
        .set('x-api-key', API_KEY_A);
    }

    // Breaker is now OPEN
    expect(await registry.getState(API_ID_A)).toBe(CircuitBreakerState.OPEN);

    billingMock.mockClear();
    (global.fetch as jest.Mock).mockClear();

    const res = await request(app)
      .get(`/api/gateway/${API_ID_A}`)
      .set('x-api-key', API_KEY_A);

    expect(res.status).toBe(503);
    // After the breaker opens, billing and upstream must not be touched
    expect(billingMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Isolation: failures on api-A do NOT trip api-B ─────────────────────

  it('breaker isolation — failures on api-A do not affect api-B', async () => {
    const FAILURE_THRESHOLD = 2;

    const fetchMock = jest.fn()
      // First N calls for api-A fail
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      // api-B call succeeds
      .mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ ok: true }),
      } as Response);

    global.fetch = fetchMock;

    const registry = new BreakerRegistry();
    registry.getOrCreate(API_ID_A, { failureThreshold: FAILURE_THRESHOLD, cooldownMs: 999_999 });
    registry.getOrCreate(API_ID_B, { failureThreshold: FAILURE_THRESHOLD, cooldownMs: 999_999 });
    const app = buildApp(registry);

    // Trip api-A's breaker
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await request(app)
        .get(`/api/gateway/${API_ID_A}`)
        .set('x-api-key', API_KEY_A);
    }

    expect(await registry.getState(API_ID_A)).toBe(CircuitBreakerState.OPEN);

    // api-B must still be operational
    const res = await request(app)
      .get(`/api/gateway/${API_ID_B}`)
      .set('x-api-key', API_KEY_B);

    expect(res.status).toBe(200);
    expect(await registry.getState(API_ID_B)).toBe(CircuitBreakerState.CLOSED);
  });

  // ── HALF_OPEN probe: successful probe re-closes the breaker ──────────────

  it('re-closes breaker after a successful probe in HALF_OPEN state', async () => {
    const COOLDOWN_MS = 50; // very short for test speed

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ recovered: true }),
    } as Response);

    const registry = new BreakerRegistry();
    const breaker = registry.getOrCreate(API_ID_A, {
      failureThreshold: 1,
      cooldownMs: COOLDOWN_MS,
      successThreshold: 1,
    });

    // Trip the breaker with a failure timestamp
    await breaker.trip(API_ID_A);
    expect(await registry.getState(API_ID_A)).toBe(CircuitBreakerState.OPEN);

    // Wait for the cooldown to elapse — execute() will move to HALF_OPEN
    await new Promise<void>((r) => setTimeout(r, COOLDOWN_MS + 20));

    const app = buildApp(registry);

    // The probe request goes through (execute() transitions OPEN→HALF_OPEN,
    // then HALF_OPEN→CLOSED on success)
    const res = await request(app)
      .get(`/api/gateway/${API_ID_A}`)
      .set('x-api-key', API_KEY_A);

    expect(res.status).toBe(200);
    expect(await registry.getState(API_ID_A)).toBe(CircuitBreakerState.CLOSED);
  });
});
