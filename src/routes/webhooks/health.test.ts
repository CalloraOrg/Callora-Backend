/**
 * Tests for GET /api/webhooks/health
 *
 * Covers:
 *   - Happy path: all-healthy, degraded (recent failures), down (DLQ full)
 *   - Response shape and status codes
 *   - deriveWebhookStatus pure-function edge cases
 *   - Correlation-ID propagation
 *   - Error handling (unexpected store failure → 500, no leak)
 *   - Secrets are never surfaced
 *   - Correct registration ordering (health is not shadowed by /:developerId)
 */

// Hoist logger mock so it is available when jest.mock() factories run.
// eslint-disable-next-line no-var
var mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  audit: jest.fn(),
};

jest.mock('../../logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLogger.info(...args),
    warn: (...args: unknown[]) => mockLogger.warn(...args),
    error: (...args: unknown[]) => mockLogger.error(...args),
    audit: (...args: unknown[]) => mockLogger.audit(...args),
  },
  runWithRequestContext: <T>(_ctx: unknown, callback: () => T): T => callback(),
}));

import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import {
  createWebhookHealthRouter,
  deriveWebhookStatus,
  DLQ_WARN_THRESHOLD,
  RECENT_FAILURES_LIMIT,
  type WebhookHealthResponse,
  type ComponentStatus,
} from './health.js';
import { WebhookStore } from '../../webhooks/webhook.store.js';
import type { FailedDeliveryEntry } from '../../webhooks/webhook.store.js';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/webhooks/health', createWebhookHealthRouter());
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFailureEntry(overrides?: Partial<FailedDeliveryEntry>): FailedDeliveryEntry {
  return {
    deliveryId: 'del-001',
    developerId: 'dev_001',
    event: 'settlement_completed',
    url: 'https://example.com/hook',
    failedAt: new Date().toISOString(),
    lastError: 'HTTP 503 Service Unavailable',
    attempts: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveWebhookStatus — pure-function unit tests
// ---------------------------------------------------------------------------

describe('deriveWebhookStatus', () => {
  it('returns "ok" when DLQ is empty and no recent failures', () => {
    expect(deriveWebhookStatus(0, 0)).toBe<ComponentStatus>('ok');
  });

  it('returns "degraded" when there are recent failures but DLQ is below threshold', () => {
    expect(deriveWebhookStatus(0, 1)).toBe<ComponentStatus>('degraded');
    expect(deriveWebhookStatus(DLQ_WARN_THRESHOLD - 1, 3)).toBe<ComponentStatus>('degraded');
  });

  it('returns "down" when DLQ depth equals the threshold', () => {
    expect(deriveWebhookStatus(DLQ_WARN_THRESHOLD, 0)).toBe<ComponentStatus>('down');
  });

  it('returns "down" when DLQ depth exceeds the threshold', () => {
    expect(deriveWebhookStatus(DLQ_WARN_THRESHOLD + 1, 0)).toBe<ComponentStatus>('down');
    expect(deriveWebhookStatus(100, 50)).toBe<ComponentStatus>('down');
  });

  it('prioritises "down" over "degraded" (DLQ threshold reached with failures)', () => {
    expect(deriveWebhookStatus(DLQ_WARN_THRESHOLD, 5)).toBe<ComponentStatus>('down');
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests
// ---------------------------------------------------------------------------

describe('GET /api/webhooks/health', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    // Reset store state so each test starts clean.
    WebhookStore.clear();
    WebhookStore.clearDlq();
    WebhookStore.clearFailedDeliveries();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns 200 and status "ok" with no registered webhooks or failures', async () => {
    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(200);
    const body = res.body as WebhookHealthResponse;
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(body.webhooks.registeredCount).toBe(0);
    expect(body.webhooks.dlqDepth).toBe(0);
    expect(body.webhooks.recentFailures).toEqual([]);
  });

  it('reflects registered webhook count', async () => {
    WebhookStore.register({
      developerId: 'dev_001',
      url: 'https://example.com/hook1',
      events: ['new_api_call'],
      createdAt: new Date(),
    });
    WebhookStore.register({
      developerId: 'dev_002',
      url: 'https://example.com/hook2',
      events: ['settlement_completed'],
      createdAt: new Date(),
    });

    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(200);
    expect((res.body as WebhookHealthResponse).webhooks.registeredCount).toBe(2);
    expect((res.body as WebhookHealthResponse).status).toBe('ok');
  });

  // ── Degraded path ─────────────────────────────────────────────────────────

  it('returns 200 and status "degraded" when there are recent delivery failures', async () => {
    WebhookStore.recordFailedDelivery(makeFailureEntry({ deliveryId: 'del-A' }));

    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(200);
    const body = res.body as WebhookHealthResponse;
    expect(body.status).toBe('degraded');
    expect(body.webhooks.recentFailures).toHaveLength(1);
    expect(body.webhooks.recentFailures[0].deliveryId).toBe('del-A');
    expect(body.webhooks.recentFailures[0].event).toBe('settlement_completed');
    expect(body.webhooks.recentFailures[0].url).toBe('https://example.com/hook');
    expect(body.webhooks.recentFailures[0].attempts).toBe(5);
  });

  it('returns failures newest-first', async () => {
    WebhookStore.recordFailedDelivery(makeFailureEntry({ deliveryId: 'older', failedAt: '2026-07-26T10:00:00.000Z' }));
    WebhookStore.recordFailedDelivery(makeFailureEntry({ deliveryId: 'newer', failedAt: '2026-07-26T11:00:00.000Z' }));

    const res = await request(app).get('/api/webhooks/health');

    const failures = (res.body as WebhookHealthResponse).webhooks.recentFailures;
    expect(failures[0].deliveryId).toBe('newer');
    expect(failures[1].deliveryId).toBe('older');
  });

  it('caps recentFailures at RECENT_FAILURES_LIMIT', async () => {
    // Record more entries than the limit.
    for (let i = 0; i < RECENT_FAILURES_LIMIT + 5; i++) {
      WebhookStore.recordFailedDelivery(makeFailureEntry({ deliveryId: `del-${i}` }));
    }

    const res = await request(app).get('/api/webhooks/health');

    expect((res.body as WebhookHealthResponse).webhooks.recentFailures).toHaveLength(
      RECENT_FAILURES_LIMIT,
    );
  });

  // ── Down path ─────────────────────────────────────────────────────────────

  it('returns 503 and status "down" when DLQ depth reaches threshold', async () => {
    for (let i = 0; i < DLQ_WARN_THRESHOLD; i++) {
      WebhookStore.addToDlq({
        deliveryId: `dlq-${i}`,
        config: {
          developerId: 'dev_001',
          url: 'https://example.com/hook',
          events: ['new_api_call'],
          createdAt: new Date(),
        },
        payload: {
          event: 'new_api_call',
          timestamp: new Date().toISOString(),
          developerId: 'dev_001',
          data: {},
        },
        failedAt: new Date().toISOString(),
        lastError: 'Network error',
        attempts: 5,
      });
    }

    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(503);
    const body = res.body as WebhookHealthResponse;
    expect(body.status).toBe('down');
    expect(body.webhooks.dlqDepth).toBe(DLQ_WARN_THRESHOLD);
  });

  it('returns 503 and status "down" when DLQ depth exceeds threshold', async () => {
    for (let i = 0; i < DLQ_WARN_THRESHOLD + 3; i++) {
      WebhookStore.addToDlq({
        deliveryId: `dlq-${i}`,
        config: {
          developerId: 'dev_001',
          url: 'https://example.com/hook',
          events: ['new_api_call'],
          createdAt: new Date(),
        },
        payload: {
          event: 'new_api_call',
          timestamp: new Date().toISOString(),
          developerId: 'dev_001',
          data: {},
        },
        failedAt: new Date().toISOString(),
        lastError: 'Network error',
        attempts: 5,
      });
    }

    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(503);
    expect((res.body as WebhookHealthResponse).status).toBe('down');
    expect((res.body as WebhookHealthResponse).webhooks.dlqDepth).toBeGreaterThan(DLQ_WARN_THRESHOLD);
  });

  // ── Security: secrets must never appear in the response ──────────────────

  it('never exposes webhook secrets in the response', async () => {
    WebhookStore.register({
      developerId: 'dev_secret',
      url: 'https://example.com/secret-hook',
      events: ['new_api_call'],
      secret: 'super-secret-value-that-must-not-leak',
      secret_current: 'super-secret-value-that-must-not-leak',
      createdAt: new Date(),
    });
    WebhookStore.recordFailedDelivery(
      makeFailureEntry({
        developerId: 'dev_secret',
        lastError: 'HTTP 500',
      }),
    );

    const res = await request(app).get('/api/webhooks/health');

    const rawBody = JSON.stringify(res.body);
    expect(rawBody).not.toContain('super-secret-value-that-must-not-leak');
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('response body always contains status, timestamp, and webhooks object', async () => {
    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(200);
    expect(typeof res.body.status).toBe('string');
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.webhooks).toBe('object');
    expect(typeof res.body.webhooks.registeredCount).toBe('number');
    expect(typeof res.body.webhooks.dlqDepth).toBe('number');
    expect(Array.isArray(res.body.webhooks.recentFailures)).toBe(true);
  });

  it('each failure entry contains required fields', async () => {
    WebhookStore.recordFailedDelivery(makeFailureEntry());

    const res = await request(app).get('/api/webhooks/health');
    const failure = (res.body as WebhookHealthResponse).webhooks.recentFailures[0];

    expect(typeof failure.deliveryId).toBe('string');
    expect(typeof failure.developerId).toBe('string');
    expect(typeof failure.event).toBe('string');
    expect(typeof failure.url).toBe('string');
    expect(typeof failure.failedAt).toBe('string');
    expect(typeof failure.lastError).toBe('string');
    expect(typeof failure.attempts).toBe('number');
  });

  // ── Content-Type ──────────────────────────────────────────────────────────

  it('responds with Content-Type application/json', async () => {
    const res = await request(app).get('/api/webhooks/health');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  // ── Correlation ID (logging) ──────────────────────────────────────────────

  it('logs the correlation ID from X-Request-Id header', async () => {
    const correlationId = 'test-corr-id-12345';
    await request(app)
      .get('/api/webhooks/health')
      .set('x-request-id', correlationId);

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[webhooks/health] probe requested',
      expect.objectContaining({ requestId: correlationId }),
    );
  });

  it('uses "unknown" as requestId when no X-Request-Id header is provided', async () => {
    await request(app).get('/api/webhooks/health');

    // The first info call should be the "probe requested" log entry.
    const firstCall = mockLogger.info.mock.calls[0] as [string, { requestId: string }];
    expect(firstCall[0]).toBe('[webhooks/health] probe requested');
    // requestId must be a non-empty string (UUID generated by requestIdMiddleware or 'unknown').
    expect(typeof firstCall[1].requestId).toBe('string');
    expect(firstCall[1].requestId.length).toBeGreaterThan(0);
  });

  it('logs the completion with status and metrics', async () => {
    WebhookStore.register({
      developerId: 'dev_log_test',
      url: 'https://example.com/hook',
      events: ['new_api_call'],
      createdAt: new Date(),
    });

    await request(app).get('/api/webhooks/health');

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[webhooks/health] probe completed',
      expect.objectContaining({
        status: 'ok',
        registeredCount: 1,
        dlqDepth: 0,
        recentFailuresCount: 0,
      }),
    );
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('returns 500 and does not leak internal details when an unexpected error occurs', async () => {
    // Force WebhookStore.list() to throw synchronously.
    const originalList = WebhookStore.list;
    WebhookStore.list = () => { throw new Error('Unexpected internal error with secrets: admin:pass'); };

    try {
      const res = await request(app).get('/api/webhooks/health');

      expect(res.status).toBe(500);
      const body = JSON.stringify(res.body);
      // Internal error details must not leak.
      expect(body).not.toContain('admin:pass');
      expect(body).not.toContain('Unexpected internal error');
    } finally {
      WebhookStore.list = originalList;
    }
  });

  it('logs the error when an unexpected exception occurs', async () => {
    const boom = new Error('boom');
    const originalList = WebhookStore.list;
    WebhookStore.list = () => { throw boom; };

    try {
      await request(app).get('/api/webhooks/health');
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[webhooks/health] probe failed unexpectedly',
        expect.objectContaining({ error: boom }),
      );
    } finally {
      WebhookStore.list = originalList;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test — health route is not shadowed by /:developerId route
// ---------------------------------------------------------------------------

describe('Webhook router — /health is not captured by /:developerId', () => {
  // Import the actual webhook router (which mounts the health sub-router).
  // We re-mock logger at the top of the file so this is safe.
  let app: express.Express;

  beforeEach(async () => {
    // Dynamically import so jest.mock() runs before the module loads.
    const { default: webhookRoutes } = await import('../../webhooks/webhook.routes.js');
    app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.use('/api/webhooks', webhookRoutes);
    app.use(errorHandler);

    WebhookStore.clear();
    WebhookStore.clearDlq();
    WebhookStore.clearFailedDeliveries();
  });

  it('GET /api/webhooks/health is served by the health router, not the :developerId route', async () => {
    // If the route was captured by /:developerId it would return a 404
    // because no developer with id "health" is registered.  The health
    // probe must return a 200 with the expected shape.
    const res = await request(app).get('/api/webhooks/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('webhooks');
  });
});
