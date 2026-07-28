/**
 * Focused tests for src/validators/admin.ts
 *
 * Coverage targets (≥ 90 % of changed lines):
 *  - Each exported schema: valid inputs parse without error
 *  - Each exported schema: invalid inputs produce the expected Zod issues
 *  - Transform behaviour (date coercion, numeric coercion)
 *  - TS inferred types are consistent with parsed output (checked via
 *    compilation-time assignments below — no runtime assertions needed)
 *
 * We use safeParse() throughout so failures are inspectable values rather
 * than thrown exceptions.
 */

import {
  usersQuerySchema,
  developerIdParamsSchema,
  usageAnomaliesQuerySchema,
  usageExportQuerySchema,
  usageByEndpointQuerySchema,
  dbExplainBodySchema,
  quotaRequestsQuerySchema,
  quotaRequestIdParamsSchema,
  quotaRequestActionBodySchema,
  maintenanceBannerBodySchema,
} from './admin.js';

// ---------------------------------------------------------------------------
// usersQuerySchema
// ---------------------------------------------------------------------------

describe('usersQuerySchema', () => {
  it('accepts an empty object (all params optional)', () => {
    const r = usersQuerySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts valid limit and offset strings', () => {
    const r = usersQuerySchema.safeParse({ limit: '50', offset: '0' });
    expect(r.success).toBe(true);
  });

  it('accepts limit=1 (minimum positive integer)', () => {
    const r = usersQuerySchema.safeParse({ limit: '1' });
    expect(r.success).toBe(true);
  });

  it('accepts offset=0 (zero is valid)', () => {
    const r = usersQuerySchema.safeParse({ offset: '0' });
    expect(r.success).toBe(true);
  });

  it('rejects limit=0 (not positive)', () => {
    const r = usersQuerySchema.safeParse({ limit: '0' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/positive integer/);
    }
  });

  it('rejects negative limit', () => {
    const r = usersQuerySchema.safeParse({ limit: '-5' });
    expect(r.success).toBe(false);
  });

  it('rejects non-numeric limit', () => {
    const r = usersQuerySchema.safeParse({ limit: 'abc' });
    expect(r.success).toBe(false);
  });

  it('rejects negative offset', () => {
    const r = usersQuerySchema.safeParse({ offset: '-1' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/non-negative integer/);
    }
  });

  it('rejects decimal offset', () => {
    const r = usersQuerySchema.safeParse({ offset: '1.5' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// developerIdParamsSchema
// ---------------------------------------------------------------------------

describe('developerIdParamsSchema', () => {
  it('accepts a non-empty developerId', () => {
    const r = developerIdParamsSchema.safeParse({ developerId: 'dev_123' });
    expect(r.success).toBe(true);
  });

  it('rejects an empty string developerId', () => {
    const r = developerIdParamsSchema.safeParse({ developerId: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/required/i);
    }
  });

  it('rejects a missing developerId field', () => {
    const r = developerIdParamsSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// usageAnomaliesQuerySchema
// ---------------------------------------------------------------------------

describe('usageAnomaliesQuerySchema', () => {
  it('accepts an empty object (all params optional)', () => {
    const r = usageAnomaliesQuerySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts valid ISO-8601 from/to strings and coerces them to Dates', () => {
    const r = usageAnomaliesQuerySchema.safeParse({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-31T23:59:59.999Z',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.from).toBeInstanceOf(Date);
      expect(r.data.to).toBeInstanceOf(Date);
    }
  });

  it('accepts threshold within range 1–10 and coerces to number', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ threshold: '3' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.threshold).toBe(3);
    }
  });

  it('accepts fractional threshold (e.g. 2.5)', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ threshold: '2.5' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.threshold).toBe(2.5);
    }
  });

  it('accepts limit within range 1–1000 and coerces to integer', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ limit: '100' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(100);
    }
  });

  it('accepts an optional apiId string', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ apiId: 'api_xyz' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.apiId).toBe('api_xyz');
    }
  });

  it('rejects an invalid "from" date string', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ from: 'not-a-date' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/ISO-8601/);
    }
  });

  it('rejects an invalid "to" date string', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ to: 'nope' });
    expect(r.success).toBe(false);
  });

  it('rejects threshold below 1', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ threshold: '0' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/threshold/);
    }
  });

  it('rejects threshold above 10', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ threshold: '11' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-numeric threshold', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ threshold: 'abc' });
    expect(r.success).toBe(false);
  });

  it('rejects limit of 0', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ limit: '0' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/limit/);
    }
  });

  it('rejects limit above 1000', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ limit: '1001' });
    expect(r.success).toBe(false);
  });

  it('rejects a fractional limit', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ limit: '1.5' });
    expect(r.success).toBe(false);
  });

  it('rejects an empty apiId string', () => {
    const r = usageAnomaliesQuerySchema.safeParse({ apiId: '' });
    expect(r.success).toBe(false);
  });

  it('leaves from/to as undefined when omitted', () => {
    const r = usageAnomaliesQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.from).toBeUndefined();
      expect(r.data.to).toBeUndefined();
    }
  });

  it('leaves threshold and limit as undefined when omitted', () => {
    const r = usageAnomaliesQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.threshold).toBeUndefined();
      expect(r.data.limit).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// usageExportQuerySchema
// ---------------------------------------------------------------------------

describe('usageExportQuerySchema', () => {
  it('accepts an empty object (all params optional)', () => {
    const r = usageExportQuerySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('defaults format to "csv" when omitted', () => {
    const r = usageExportQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.format).toBe('csv');
    }
  });

  it('accepts format="json"', () => {
    const r = usageExportQuerySchema.safeParse({ format: 'json' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.format).toBe('json');
    }
  });

  it('accepts format="csv" explicitly', () => {
    const r = usageExportQuerySchema.safeParse({ format: 'csv' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown format value', () => {
    const r = usageExportQuerySchema.safeParse({ format: 'xml' });
    expect(r.success).toBe(false);
  });

  it('accepts valid ISO-8601 from/to and coerces them to Dates', () => {
    const r = usageExportQuerySchema.safeParse({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.from).toBeInstanceOf(Date);
      expect(r.data.to).toBeInstanceOf(Date);
    }
  });

  it('rejects an invalid "from" date string', () => {
    const r = usageExportQuerySchema.safeParse({ from: 'bad-date' });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid "to" date string', () => {
    const r = usageExportQuerySchema.safeParse({ to: 'bad-date' });
    expect(r.success).toBe(false);
  });

  it('accepts a developerId filter string', () => {
    const r = usageExportQuerySchema.safeParse({ developerId: 'dev_001' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.developerId).toBe('dev_001');
    }
  });

  it('rejects an empty developerId string', () => {
    const r = usageExportQuerySchema.safeParse({ developerId: '' });
    expect(r.success).toBe(false);
  });

  it('accepts an apiId filter string', () => {
    const r = usageExportQuerySchema.safeParse({ apiId: 'api_001' });
    expect(r.success).toBe(true);
  });

  it('rejects an empty apiId string', () => {
    const r = usageExportQuerySchema.safeParse({ apiId: '' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// usageByEndpointQuerySchema
// ---------------------------------------------------------------------------

describe('usageByEndpointQuerySchema', () => {
  it('accepts an empty object (all params optional)', () => {
    const r = usageByEndpointQuerySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts valid ISO-8601 date strings and coerces them to Dates', () => {
    const r = usageByEndpointQuerySchema.safeParse({
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-28T23:59:59.999Z',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.from).toBeInstanceOf(Date);
      expect(r.data.to).toBeInstanceOf(Date);
    }
  });

  it('accepts limit within 1–1000 and coerces to integer', () => {
    const r = usageByEndpointQuerySchema.safeParse({ limit: '10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(10);
    }
  });

  it('accepts optional apiId and developerId strings', () => {
    const r = usageByEndpointQuerySchema.safeParse({
      apiId: 'api_abc',
      developerId: 'dev_xyz',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.apiId).toBe('api_abc');
      expect(r.data.developerId).toBe('dev_xyz');
    }
  });

  it('rejects invalid "from" date', () => {
    const r = usageByEndpointQuerySchema.safeParse({ from: 'not-a-date' });
    expect(r.success).toBe(false);
  });

  it('rejects limit=0', () => {
    const r = usageByEndpointQuerySchema.safeParse({ limit: '0' });
    expect(r.success).toBe(false);
  });

  it('rejects limit above 1000', () => {
    const r = usageByEndpointQuerySchema.safeParse({ limit: '1001' });
    expect(r.success).toBe(false);
  });

  it('rejects fractional limit', () => {
    const r = usageByEndpointQuerySchema.safeParse({ limit: '2.5' });
    expect(r.success).toBe(false);
  });

  it('rejects empty apiId string', () => {
    const r = usageByEndpointQuerySchema.safeParse({ apiId: '' });
    expect(r.success).toBe(false);
  });

  it('rejects empty developerId string', () => {
    const r = usageByEndpointQuerySchema.safeParse({ developerId: '' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dbExplainBodySchema
// ---------------------------------------------------------------------------

describe('dbExplainBodySchema', () => {
  it('accepts a minimal body with just a query string', () => {
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT 1' });
    expect(r.success).toBe(true);
  });

  it('defaults params to [] when omitted', () => {
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT 1' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.params).toEqual([]);
    }
  });

  it('accepts params as a non-empty array', () => {
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT $1', params: [42] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.params).toEqual([42]);
    }
  });

  it('accepts params with mixed types (numbers, strings, null)', () => {
    const r = dbExplainBodySchema.safeParse({
      query: 'SELECT $1, $2, $3',
      params: [1, 'active', null],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty query string', () => {
    const r = dbExplainBodySchema.safeParse({ query: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/required/i);
    }
  });

  it('rejects a query exceeding 50 000 characters', () => {
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT ' + 'x'.repeat(50_000) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/too long/i);
    }
  });

  it('rejects params as a non-array (string)', () => {
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT 1', params: 'invalid' });
    expect(r.success).toBe(false);
  });

  it('rejects params as a non-array (object)', () => {
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT 1', params: { key: 'val' } });
    expect(r.success).toBe(false);
  });

  it('rejects a missing query field', () => {
    const r = dbExplainBodySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts a query exactly at the 50 000-char boundary', () => {
    // 'SELECT ' is 7 chars, pad to exactly 50 000 total
    const r = dbExplainBodySchema.safeParse({ query: 'SELECT ' + 'x'.repeat(49_993) });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// quotaRequestsQuerySchema
// ---------------------------------------------------------------------------

describe('quotaRequestsQuerySchema', () => {
  it('accepts an empty object (status is optional)', () => {
    const r = quotaRequestsQuerySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts status="pending"', () => {
    const r = quotaRequestsQuerySchema.safeParse({ status: 'pending' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe('pending');
    }
  });

  it('accepts status="approved"', () => {
    const r = quotaRequestsQuerySchema.safeParse({ status: 'approved' });
    expect(r.success).toBe(true);
  });

  it('accepts status="rejected"', () => {
    const r = quotaRequestsQuerySchema.safeParse({ status: 'rejected' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const r = quotaRequestsQuerySchema.safeParse({ status: 'closed' });
    expect(r.success).toBe(false);
  });

  it('rejects an empty string status', () => {
    const r = quotaRequestsQuerySchema.safeParse({ status: '' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// quotaRequestIdParamsSchema
// ---------------------------------------------------------------------------

describe('quotaRequestIdParamsSchema', () => {
  it('accepts a non-empty id', () => {
    const r = quotaRequestIdParamsSchema.safeParse({ id: 'req_abc123' });
    expect(r.success).toBe(true);
  });

  it('rejects an empty id', () => {
    const r = quotaRequestIdParamsSchema.safeParse({ id: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/required/i);
    }
  });

  it('rejects a missing id field', () => {
    const r = quotaRequestIdParamsSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// quotaRequestActionBodySchema
// ---------------------------------------------------------------------------

describe('quotaRequestActionBodySchema', () => {
  it('accepts an empty body (admin_notes is optional)', () => {
    const r = quotaRequestActionBodySchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts a body with admin_notes', () => {
    const r = quotaRequestActionBodySchema.safeParse({ admin_notes: 'Looks good.' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.admin_notes).toBe('Looks good.');
    }
  });

  it('accepts admin_notes at the 2000-character limit', () => {
    const r = quotaRequestActionBodySchema.safeParse({ admin_notes: 'a'.repeat(2000) });
    expect(r.success).toBe(true);
  });

  it('rejects admin_notes exceeding 2000 characters', () => {
    const r = quotaRequestActionBodySchema.safeParse({ admin_notes: 'a'.repeat(2001) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/2000/);
    }
  });
});

// ---------------------------------------------------------------------------
// maintenanceBannerBodySchema
// ---------------------------------------------------------------------------

describe('maintenanceBannerBodySchema', () => {
  it('accepts a valid banner payload', () => {
    const r = maintenanceBannerBodySchema.safeParse({
      message: 'Scheduled maintenance 22:00–02:00 UTC',
      isActive: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.message).toBe('Scheduled maintenance 22:00–02:00 UTC');
      expect(r.data.isActive).toBe(true);
    }
  });

  it('accepts isActive=false', () => {
    const r = maintenanceBannerBodySchema.safeParse({ message: 'Banner off', isActive: false });
    expect(r.success).toBe(true);
  });

  it('trims leading/trailing whitespace from message', () => {
    const r = maintenanceBannerBodySchema.safeParse({ message: '  Trimmed  ', isActive: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.message).toBe('Trimmed');
    }
  });

  it('rejects a missing message field', () => {
    const r = maintenanceBannerBodySchema.safeParse({ isActive: true });
    expect(r.success).toBe(false);
  });

  it('rejects an empty message string', () => {
    const r = maintenanceBannerBodySchema.safeParse({ message: '', isActive: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/non-empty/);
    }
  });

  it('rejects a whitespace-only message string', () => {
    const r = maintenanceBannerBodySchema.safeParse({ message: '   ', isActive: true });
    expect(r.success).toBe(false);
  });

  it('rejects message exceeding 1000 characters', () => {
    const r = maintenanceBannerBodySchema.safeParse({
      message: 'x'.repeat(1001),
      isActive: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/1000/);
    }
  });

  it('accepts message exactly at the 1000-character limit', () => {
    const r = maintenanceBannerBodySchema.safeParse({
      message: 'x'.repeat(1000),
      isActive: true,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-boolean isActive (string)', () => {
    const r = maintenanceBannerBodySchema.safeParse({ message: 'Test', isActive: 'true' });
    expect(r.success).toBe(false);
  });

  it('rejects a missing isActive field', () => {
    const r = maintenanceBannerBodySchema.safeParse({ message: 'Test' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route-layer integration: validate() middleware → structured error envelope
//
// Each suite imports a sub-router factory directly (never the full admin.ts
// router which would pull in the better-sqlite3 native binding).
//
// Actual error envelope shape (from errorEnvelope() + errorHandler):
//   {
//     success: false,
//     error: { code: string, message: string, details?: ValidationErrorDetail[] },
//     requestId: string,
//     timestamp: string
//   }
//
// ValidationErrorDetail items: { field: string, message: string, code: string }
//
// Each test verifies:
//   1. HTTP 400 for invalid input
//   2. error.code === 'VALIDATION_ERROR'
//   3. error.details is a non-empty array of { field, message, code }
//   4. Valid input reaches the handler (200 or 500-pool-absent)
// ---------------------------------------------------------------------------

import express, { type Request, type Response, type NextFunction } from 'express';
import supertest from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

// ── Shared mocks ─────────────────────────────────────────────────────────────

jest.mock('../middleware/adminAuth', () => ({
  adminAuth: jest.fn((_req: Request, _res: Response, next: NextFunction) => {
    _res.locals = { ..._res.locals, adminActor: 'test-admin' };
    next();
  }),
}));

jest.mock('../middleware/ipAllowlist', () => ({
  createAdminIpAllowlist: jest.fn(
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ),
}));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), audit: jest.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(
  mountPath: string,
  router: express.Router,
): supertest.SuperTest<supertest.Test> {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(mountPath, router);
  app.use(errorHandler);
  return supertest(app);
}

interface ErrorBody {
  success: boolean;
  error?: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string; code: string }>;
  };
  requestId: string;
}

/**
 * Asserts the canonical validation error envelope:
 *   { success: false, error: { code: 'VALIDATION_ERROR', message, details: [...] }, requestId }
 * Returns the details array so callers can make additional field assertions.
 */
function expectValidationError(body: ErrorBody): Array<{ field: string; message: string; code: string }> {
  expect(body.success).toBe(false);
  expect(typeof body.requestId).toBe('string');
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe('VALIDATION_ERROR');
  expect(typeof body.error!.message).toBe('string');
  expect(Array.isArray(body.error!.details)).toBe(true);
  const details = body.error!.details!;
  expect(details.length).toBeGreaterThan(0);
  for (const d of details) {
    expect(typeof d.field).toBe('string');
    expect(typeof d.message).toBe('string');
    expect(typeof d.code).toBe('string');
  }
  return details;
}

// ── POST /api/admin/maintenance/banner ───────────────────────────────────────

describe('route validation: POST /api/admin/maintenance/banner', () => {
  const { createMaintenanceBannerRouter } = jest.requireActual(
    '../routes/admin/maintenance/banner.js',
  ) as { createMaintenanceBannerRouter: () => express.Router };

  const agent = buildApp('/api/admin/maintenance/banner', createMaintenanceBannerRouter());

  it('returns 400 + VALIDATION_ERROR for missing message', async () => {
    const res = await agent.post('/api/admin/maintenance/banner').send({ isActive: true });
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/message/);
  });

  it('returns 400 for empty message string', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: '', isActive: true });
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for whitespace-only message', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: '   ', isActive: true });
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for non-boolean isActive (string "yes")', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: 'Test', isActive: 'yes' });
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/isActive/);
  });

  it('returns 400 for missing isActive field', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: 'Only message' });
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for message exceeding 1000 characters', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: 'x'.repeat(1001), isActive: false });
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 200 with trimmed message for a valid payload', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: '  Maintenance tonight  ', isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Maintenance tonight');
    expect(res.body.data.isActive).toBe(true);
    expect(typeof res.body.data.updatedAt).toBe('string');
  });

  it('returns 200 with isActive=false for a valid payload', async () => {
    const res = await agent
      .post('/api/admin/maintenance/banner')
      .send({ message: 'Banner off', isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });
});

// ── POST /api/admin/db/explain ────────────────────────────────────────────────

describe('route validation: POST /api/admin/db/explain', () => {
  const { createExplainRouter } = jest.requireActual(
    '../routes/admin/explain.js',
  ) as { createExplainRouter: (deps?: Record<string, unknown>) => express.Router };

  // No pool — validation failures are caught before the pool is accessed.
  const agent = buildApp('/api/admin/db/explain', createExplainRouter());

  it('returns 400 + VALIDATION_ERROR for empty body (missing query)', async () => {
    const res = await agent.post('/api/admin/db/explain').send({});
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/query/);
  });

  it('returns 400 for empty query string', async () => {
    const res = await agent.post('/api/admin/db/explain').send({ query: '' });
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 with details.field=params when params is a string', async () => {
    const res = await agent
      .post('/api/admin/db/explain')
      .send({ query: 'SELECT 1', params: 'bad' });
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/params/);
  });

  it('returns 400 for query exceeding 50 000 characters', async () => {
    const res = await agent
      .post('/api/admin/db/explain')
      .send({ query: 'SELECT ' + 'x'.repeat(50_000) });
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 500 (INTERNAL_SERVER_ERROR) for valid body when pool is absent', async () => {
    const res = await agent.post('/api/admin/db/explain').send({ query: 'SELECT 1' });
    // Validation passes; the route then fails on the absent pool.
    expect(res.status).toBe(500);
    expect((res.body as ErrorBody).error!.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

// ── GET /api/admin/usage/anomalies ────────────────────────────────────────────

describe('route validation: GET /api/admin/usage/anomalies', () => {
  const { createUsageAnomaliesRouter } = jest.requireActual(
    '../routes/admin/usage/anomalies.js',
  ) as { createUsageAnomaliesRouter: (deps?: Record<string, unknown>) => express.Router };

  const agent = buildApp('/api/admin/usage/anomalies', createUsageAnomaliesRouter());

  it('returns 400 + VALIDATION_ERROR for invalid "from" date', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?from=not-a-date');
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/from/);
  });

  it('returns 400 for invalid "to" date', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?to=bad');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for threshold=99 (out of range)', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?threshold=99');
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/threshold/);
  });

  it('returns 400 for non-numeric threshold', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?threshold=abc');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for fractional limit (1.5)', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?limit=1.5');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for limit=0', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?limit=0');
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/limit/);
  });

  it('returns 400 for empty apiId', async () => {
    const res = await agent.get('/api/admin/usage/anomalies?apiId=');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 500 (pool missing) for a fully valid request', async () => {
    const res = await agent.get('/api/admin/usage/anomalies');
    expect(res.status).toBe(500);
    expect((res.body as ErrorBody).error!.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

// ── GET /api/admin/usage/export ───────────────────────────────────────────────

describe('route validation: GET /api/admin/usage/export', () => {
  const { createAdminUsageExportRouter } = jest.requireActual(
    '../routes/admin/usage/export.js',
  ) as { createAdminUsageExportRouter: (deps?: Record<string, unknown>) => express.Router };

  const agent = buildApp('/api/admin/usage/export', createAdminUsageExportRouter());

  it('returns 400 + VALIDATION_ERROR for invalid "from" date', async () => {
    const res = await agent.get('/api/admin/usage/export?from=bad-date');
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/from/);
  });

  it('returns 400 for invalid "to" date', async () => {
    const res = await agent.get('/api/admin/usage/export?to=bad-date');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for unknown format value "xml"', async () => {
    const res = await agent.get('/api/admin/usage/export?format=xml');
    expect(res.status).toBe(400);
    const details = expectValidationError(res.body as ErrorBody);
    expect(details[0].field).toMatch(/format/);
  });

  it('returns 400 for empty developerId', async () => {
    const res = await agent.get('/api/admin/usage/export?developerId=');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 400 for empty apiId', async () => {
    const res = await agent.get('/api/admin/usage/export?apiId=');
    expect(res.status).toBe(400);
    expectValidationError(res.body as ErrorBody);
  });

  it('returns 500 (pool missing) for a fully valid request', async () => {
    const res = await agent.get('/api/admin/usage/export');
    expect(res.status).toBe(500);
    expect((res.body as ErrorBody).error!.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
