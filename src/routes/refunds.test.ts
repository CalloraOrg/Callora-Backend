/**
 * Tests for the refunds router.
 *
 * Covers:
 *   POST   /api/refunds              - submit a new refund request
 *   GET    /api/refunds              - list caller's own refund requests
 *   GET    /api/refunds/:id          - fetch a single refund request by ID
 *   POST   /api/refunds/:id/approve  - admin approves/rejects a refund request
 *
 * Edge cases:
 *   - Missing / invalid auth
 *   - Zod validation failures
 *   - Cross-user ownership guard (GET /:id returns 404 for other user's request)
 *   - Status filter for list endpoint
 *   - Store isolation via clearRefundStore in beforeEach
 *   - Tracing spans created for each endpoint
 */

import request from 'supertest';
import express from 'express';
import refundsRouter, { getRefundStore, clearRefundStore } from './refunds.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { __setTracer } from '../otel/spans.js';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer, SpanOptions as OtelSpanOptions } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/refunds', refundsRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validBody = {
  usageEventId: '123e4567-e89b-12d3-a456-426614174000',
  reason: 'Service was unavailable during the call period',
  amountUsdc: '10.50',
};

const ADMIN_KEY = 'test-admin-key';

// ---------------------------------------------------------------------------
// In-memory mock tracer for span assertions
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  kind: number;
  attributes: Record<string, string>;
  status: { code: number; message?: string };
  exceptions: Error[];
  ended: boolean;
}

function createInMemoryTracer(): { tracer: Tracer; getSpans: () => RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tracer: any = {
    startSpan(name: string, options?: OtelSpanOptions): Span {
      const recorded: RecordedSpan = {
        name,
        kind: options?.kind ?? SpanKind.INTERNAL,
        attributes: {},
        status: { code: SpanStatusCode.UNSET },
        exceptions: [],
        ended: false,
      };
      spans.push(recorded);

      const recordErr = (exception: Error) => {
        recorded.exceptions.push(exception);
      };

      const mockSpan = {
        setAttribute(key: string, value: string) {
          recorded.attributes[key] = value;
          return this;
        },
        setAttributes(_attributes: Record<string, string>) {
          Object.assign(recorded.attributes, _attributes);
          return this;
        },
        setStatus(status: { code: number; message?: string }) {
          recorded.status = status;
          return this;
        },
        recordException: recordErr,
        end() {
          recorded.ended = true;
        },
        spanContext() {
          return {
            traceId: 'trace-id',
            spanId: 'span-id',
            traceFlags: 1,
          };
        },
        isRecording() {
          return true;
        },
        addEvent() {
          return this;
        },
        addLink() {
          return this;
        },
        updateName() {
          return this;
        },
      };

      return mockSpan as unknown as Span;
    },
    startActiveSpan(name: string, optionsOrFn: unknown, maybeFn?: unknown) {
      const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
      const span = tracer.startSpan(name);
      return (fn as (span: Span) => unknown)(span);
    },
  };

  return { tracer, getSpans: () => spans };
}

// ---------------------------------------------------------------------------
// POST /api/refunds
// ---------------------------------------------------------------------------

describe('POST /api/refunds', () => {
  beforeEach(() => {
    clearRefundStore();
  });

  it('201 - creates a pending refund request with required fields', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      developerId: 'dev-1',
      usageEventId: '123e4567-e89b-12d3-a456-426614174000',
      reason: 'Service was unavailable during the call period',
      amountUsdc: '10.50',
      status: 'pending',
    });
    expect(typeof res.body.data.id).toBe('string');
    // UUID format
    expect(res.body.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(res.body.data.createdAt).toBeDefined();
    expect(res.body.data.updatedAt).toBeDefined();
    expect(res.body.data.resolvedAt).toBeUndefined();
    expect(res.body.data.resolvedBy).toBeUndefined();
    expect(res.body.data.adminNotes).toBeUndefined();
  });

  it('201 - persists the refund request in the store', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-42')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174001', reason: 'Testing refund persistence', amountUsdc: '5.00' });

    const store = getRefundStore();
    expect(store.size).toBe(1);
    const refund = store.values().next().value;
    expect(refund?.developerId).toBe('dev-42');
    expect(refund?.status).toBe('pending');
  });

  it('400 VALIDATION_ERROR - missing required fields', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('400 VALIDATION_ERROR - invalid usageEventId format', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: 'not-a-uuid', reason: 'Valid reason for the refund request', amountUsdc: '10.00' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - reason too short (< 10 chars)', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174000', reason: 'Short', amountUsdc: '10.00' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - reason too long (> 1000 chars)', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174000', reason: 'x'.repeat(1001), amountUsdc: '10.00' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - invalid amountUsdc format', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174000', reason: 'Valid reason for refund request', amountUsdc: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR - non-positive amountUsdc', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174000', reason: 'Valid reason for refund request', amountUsdc: '0' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('401 - no authentication provided', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it('returns X-Request-Id header in response', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'test-req-id-123')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.headers['x-request-id']).toBe('test-req-id-123');
  });
});

// ---------------------------------------------------------------------------
// GET /api/refunds
// ---------------------------------------------------------------------------

describe('GET /api/refunds', () => {
  beforeEach(() => {
    clearRefundStore();
  });

  it('200 - returns empty array when no requests exist', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/api/refunds')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('200 - returns only the callers own requests', async () => {
    const app = createTestApp();

    // Create refunds for two different developers
    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-2')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174002', reason: 'Other developer refund request', amountUsdc: '25.00' });

    const res = await request(app)
      .get('/api/refunds')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].developerId).toBe('dev-1');
    expect(res.body.meta.total).toBe(1);
  });

  it('200 - returns multiple requests for the same developer', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174003', reason: 'Second refund request for different event', amountUsdc: '15.00' });

    const res = await request(app)
      .get('/api/refunds')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(2);
    res.body.data.forEach((r: { developerId: string }) => {
      expect(r.developerId).toBe('dev-1');
    });
  });

  it('200 - filters by ?status=pending', async () => {
    const app = createTestApp();

    // Create a pending refund
    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174004', reason: 'Pending refund request', amountUsdc: '10.00' });

    // Create another refund and manually update it to approved
    const r2 = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174005', reason: 'Will be marked approved', amountUsdc: '20.00' });

    // Mark r2 as approved
    const store = getRefundStore();
    const refund2 = store.get(r2.body.data.id);
    if (refund2) {
      refund2.status = 'approved';
      refund2.resolvedAt = new Date();
      refund2.resolvedBy = 'admin-1';
    }

    const res = await request(app)
      .get('/api/refunds?status=pending')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('pending');
    expect(res.body.meta.total).toBe(1);
  });

  it('200 - filters by ?status=approved', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174005', reason: 'Will remain pending', amountUsdc: '10.00' });

    const r2 = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174006', reason: 'Will be marked approved', amountUsdc: '20.00' });

    // Mark r2 as approved
    const store = getRefundStore();
    const refund2 = store.get(r2.body.data.id);
    if (refund2) {
      refund2.status = 'approved';
      refund2.resolvedAt = new Date();
      refund2.resolvedBy = 'admin-1';
    }

    const res = await request(app)
      .get('/api/refunds?status=approved')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('approved');
    expect(res.body.meta.total).toBe(1);
  });

  it('200 - filters by ?status=rejected', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174007', reason: 'Will stay pending', amountUsdc: '10.00' });

    const r2 = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174008', reason: 'Will be marked rejected', amountUsdc: '30.00' });

    const store = getRefundStore();
    const refund2 = store.get(r2.body.data.id);
    if (refund2) {
      refund2.status = 'rejected';
      refund2.resolvedAt = new Date();
      refund2.resolvedBy = 'admin-1';
    }

    const res = await request(app)
      .get('/api/refunds?status=rejected')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('rejected');
    expect(res.body.meta.total).toBe(1);
  });

  it('400 VALIDATION_ERROR - invalid status query param', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/api/refunds?status=invalid')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('401 - no authentication provided (list)', async () => {
    const app = createTestApp();

    const res = await request(app).get('/api/refunds');

    expect(res.status).toBe(401);
  });

  it('200 - pagination with limit and offset', async () => {
    const app = createTestApp();

    // Create 5 refund requests
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/refunds')
        .set('x-user-id', 'dev-1')
        .send({ usageEventId: `123e4567-e89b-12d3-a456-426614174${i.toString().padStart(3, '0')}`, reason: `Refund request number ${i}`, amountUsdc: `${i + 1}.00` });
    }

    const res = await request(app)
      .get('/api/refunds?limit=2&offset=1')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(5);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.meta.offset).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/refunds/:id
// ---------------------------------------------------------------------------

describe('GET /api/refunds/:id', () => {
  beforeEach(() => {
    clearRefundStore();
  });

  it('200 - returns the callers own request by ID', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const id = created.body.data.id;

    const res = await request(app)
      .get(`/api/refunds/${id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.developerId).toBe('dev-1');
    expect(res.body.data.usageEventId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(res.body.data.amountUsdc).toBe('10.50');
    expect(res.body.data.status).toBe('pending');
  });

  it('200 - response includes all expected fields', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({
        usageEventId: '123e4567-e89b-12d3-a456-426614174009',
        reason: 'Running large-scale production APIs needing refund',
        amountUsdc: '100.00',
      });

    const id = created.body.data.id;
    const res = await request(app)
      .get(`/api/refunds/${id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      developerId: 'dev-1',
      usageEventId: '123e4567-e89b-12d3-a456-426614174009',
      reason: 'Running large-scale production APIs needing refund',
      amountUsdc: '100.00',
      status: 'pending',
    });
    expect(res.body.data.createdAt).toBeDefined();
    expect(res.body.data.updatedAt).toBeDefined();
  });

  it('404 REFUND_NOT_FOUND - nonexistent ID', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/api/refunds/123e4567-e89b-12d3-a456-426614174000')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REFUND_NOT_FOUND');
  });

  it('404 REFUND_NOT_FOUND - ID belongs to different developer (ownership guard)', async () => {
    const app = createTestApp();

    // dev-2 creates a refund request
    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-2')
      .send(validBody);

    const id = created.body.data.id;

    // dev-1 tries to fetch dev-2 request - should get 404, not 403
    const res = await request(app)
      .get(`/api/refunds/${id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REFUND_NOT_FOUND');
  });

  it('401 - no authentication provided (get by id)', async () => {
    const app = createTestApp();

    const res = await request(app).get('/api/refunds/some-id');

    expect(res.status).toBe(401);
  });

  it('200 - caller can access their own approved request', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174010', reason: 'Refund that will be approved by admin', amountUsdc: '50.00' });

    const store = getRefundStore();
    const refund = store.get(created.body.data.id);
    if (refund) {
      refund.status = 'approved';
      refund.resolvedAt = new Date();
      refund.resolvedBy = 'admin-1';
      refund.adminNotes = 'Approved after review';
    }

    const res = await request(app)
      .get(`/api/refunds/${created.body.data.id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.adminNotes).toBe('Approved after review');
    expect(res.body.data.resolvedBy).toBe('admin-1');
  });

  it('200 - caller can access their own rejected request', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send({ usageEventId: '123e4567-e89b-12d3-a456-426614174011', reason: 'Refund that will be rejected by admin', amountUsdc: '75.00' });

    const store = getRefundStore();
    const refund = store.get(created.body.data.id);
    if (refund) {
      refund.status = 'rejected';
      refund.resolvedAt = new Date();
      refund.resolvedBy = 'admin-1';
      refund.adminNotes = 'Insufficient evidence provided';
    }

    const res = await request(app)
      .get(`/api/refunds/${created.body.data.id}`)
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.adminNotes).toBe('Insufficient evidence provided');
    expect(res.body.data.resolvedBy).toBe('admin-1');
  });
});

// ---------------------------------------------------------------------------
// POST /api/refunds/:id/approve (admin)
// ---------------------------------------------------------------------------

describe('POST /api/refunds/:id/approve', () => {
  beforeEach(() => {
    clearRefundStore();
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  it('returns 401 without admin auth', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const res = await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .send({ resolution: 'APPROVED' });

    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid body', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const res = await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({}); // missing resolution

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid resolution value', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const res = await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'CANCELLED' });

    expect(res.status).toBe(400);
  });

  it('approves a refund request as admin (APPROVED)', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const res = await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'APPROVED', adminNotes: 'Refund approved per policy' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.resolvedBy).toBe('admin-api-key');
    expect(res.body.data.adminNotes).toBe('Refund approved per policy');
    expect(res.body.data.resolvedAt).toBeDefined();
  });

  it('rejects a refund request as admin (REJECTED)', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const res = await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'REJECTED', adminNotes: 'Charge was valid' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.resolvedBy).toBe('admin-api-key');
    expect(res.body.data.adminNotes).toBe('Charge was valid');
    expect(res.body.data.resolvedAt).toBeDefined();
  });

  it('returns 404 for unknown refund request', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/refunds/123e4567-e89b-12d3-a456-426614174000/approve')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'APPROVED' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REFUND_NOT_FOUND');
  });

  it('returns 400 when refund already resolved', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    // First resolve it
    await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'APPROVED' });

    // Try to resolve again
    const res = await request(app)
      .post(`/api/refunds/${created.body.data.id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'REJECTED' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REFUND_ALREADY_RESOLVED');
  });
});

// ---------------------------------------------------------------------------
// Tracing span tests
// ---------------------------------------------------------------------------

describe('Tracing spans for /api/refunds', () => {
  let getSpans: () => RecordedSpan[];

  beforeEach(() => {
    clearRefundStore();
    const { tracer, getSpans: getSpansFn } = createInMemoryTracer();
    getSpans = getSpansFn;
    __setTracer(tracer);
  });

  afterAll(() => {
    // Restore the default tracer so subsequent test suites aren't affected.
    __setTracer(trace.getTracer('callora-quota-service'));
  });

  it('creates a span named POST /api/refunds on create', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'trace-test-1')
      .send(validBody);

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('POST /api/refunds');
    expect(spans[0].kind).toBe(SpanKind.INTERNAL);
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    expect(spans[0].ended).toBe(true);
  });

  it('sets requestId attribute on the span from x-request-id header', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'span-req-id-42')
      .send(validBody);

    const spans = getSpans();
    expect(spans[0].attributes.requestId).toBe('span-req-id-42');
  });

  it('creates a span named GET /api/refunds on list', async () => {
    const app = createTestApp();

    await request(app)
      .get('/api/refunds')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'trace-test-2');

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('GET /api/refunds');
    expect(spans[0].kind).toBe(SpanKind.INTERNAL);
    expect(spans[0].attributes.requestId).toBe('trace-test-2');
  });

  it('creates a span named GET /api/refunds/:id on fetch by ID', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const id = created.body.data.id;

    // Reset spans to only capture the GET span
    const { tracer, getSpans: getSpansFn } = createInMemoryTracer();
    getSpans = getSpansFn;
    __setTracer(tracer);

    await request(app)
      .get(`/api/refunds/${id}`)
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'trace-test-3');

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('GET /api/refunds/:id');
    expect(spans[0].attributes.requestId).toBe('trace-test-3');
  });

  it('creates a span named POST /api/refunds/:id/approve on admin approve', async () => {
    const app = createTestApp();

    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const id = created.body.data.id;

    // Reset spans to only capture the POST approve span
    const { tracer, getSpans: getSpansFn } = createInMemoryTracer();
    getSpans = getSpansFn;
    __setTracer(tracer);

    await request(app)
      .post(`/api/refunds/${id}/approve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .set('x-request-id', 'trace-test-4')
      .send({ resolution: 'APPROVED' });

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('POST /api/refunds/:id/approve');
    expect(spans[0].attributes.requestId).toBe('trace-test-4');
  });

  it('records exception and marks span as ERROR when the handler throws', async () => {
    const app = createTestApp();

    // Trigger a 404 by fetching a nonexistent ID
    await request(app)
      .get('/api/refunds/123e4567-e89b-12d3-a456-426614174000')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'trace-error-1');

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].exceptions).toHaveLength(1);
    expect(spans[0].exceptions[0].message).toContain('Refund request not found');
  });

  it('records exception and marks span as ERROR on ownership guard (cross-user access)', async () => {
    const app = createTestApp();

    // dev-2 creates a refund request
    const created = await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-2')
      .send(validBody);

    const id = created.body.data.id;

    // Reset spans to only capture the GET span
    const { tracer, getSpans: getSpansFn } = createInMemoryTracer();
    getSpans = getSpansFn;
    __setTracer(tracer);

    // dev-1 tries to fetch dev-2's request — ownership guard throws NotFoundError
    await request(app)
      .get(`/api/refunds/${id}`)
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'trace-ownership-guard');

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].exceptions).toHaveLength(1);
    expect(spans[0].exceptions[0].message).toContain('Refund request not found');
  });

  it('ends every span in the finally block even on success', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/refunds')
      .set('x-user-id', 'dev-1')
      .send(validBody);

    const spans = getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].ended).toBe(true);
  });

  it('ends every span in the finally block even on error', async () => {
    const app = createTestApp();

    await request(app)
      .get('/api/refunds/123e4567-e89b-12d3-a456-426614174000')
      .set('x-user-id', 'dev-1');

    const spans = getSpans();
    expect(spans[0].ended).toBe(true);
  });
});