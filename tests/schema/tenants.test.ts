/**
 * Response schema stability tests for /api/tenants
 *
 * Snapshot tests that assert the POST /api/tenants and PATCH /api/tenants/:tenantId
 * response shapes don't drift accidentally across code changes.
 *
 * Strategy:
 *  - Build a minimal Express app with requestIdMiddleware + errorHandler so the
 *    test is self-contained and doesn't pull in unrelated app infrastructure.
 *  - Inject a deterministic MockTenantRepository so every response is stable
 *    (fixed IDs, fixed timestamps) and suitable for snapshot comparison.
 *  - Use toMatchSnapshot() for full structural snapshots and explicit field-type
 *    assertions for fine-grained schema-drift detection.
 *  - Cover success envelopes (201 create, 200 update), validation error envelopes
 *    (400), and the authentication error envelope (401).
 *
 * Closes #919 — GrantFox FWC26 campaign
 */

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { requestIdMiddleware } from '../../src/middleware/requestId.js';
import {
  createTenantsRouter,
  type TenantRecord,
  type TenantRepository,
} from '../../src/routes/tenants.js';
import type { CreateTenantInput, UpdateTenantInput } from '../../src/validators/tenants.js';

// ---------------------------------------------------------------------------
// Deterministic test doubles
// ---------------------------------------------------------------------------

/**
 * Fixed timestamps used throughout these tests so snapshots remain stable
 * across runs regardless of wall-clock time.
 */
const FIXED_CREATED_AT = '2026-07-28T00:00:00.000Z';
const FIXED_UPDATED_AT = '2026-07-28T01:00:00.000Z';

/**
 * Deterministic tenant repository that returns predictable, fixed records.
 * No real storage — values are constant so snapshots never drift due to
 * non-deterministic data.
 */
class MockTenantRepository implements TenantRepository {
  create = jest.fn(
    async (input: CreateTenantInput, actorId: string): Promise<TenantRecord> => ({
      id: 'ten_fixture_001',
      name: input.name,
      slug: input.slug ?? 'grantfox-ops',
      contactEmail: input.contactEmail,
      plan: input.plan,
      metadata: input.metadata,
      createdBy: actorId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_CREATED_AT,
    }),
  );

  update = jest.fn(
    async (tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord> => ({
      id: tenantId,
      name: input.name ?? 'GrantFox Ops',
      slug: 'grantfox-ops',
      contactEmail: input.contactEmail,
      plan: input.plan ?? 'starter',
      metadata: input.metadata,
      createdBy: actorId,
      createdAt: FIXED_CREATED_AT,
      updatedAt: FIXED_UPDATED_AT,
    }),
  );
}

/**
 * Build a minimal Express application wired up identically to how the real
 * app mounts the tenants router, but without any unrelated middleware.
 * Accepts an optional repository so individual tests can inject their own spy.
 */
function buildApp(repository: TenantRepository = new MockTenantRepository()) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/tenants', createTenantsRouter({ tenantRepository: repository }));
  app.use(errorHandler);
  return { app, repository };
}

// ---------------------------------------------------------------------------
// POST /api/tenants — success envelope schema
// ---------------------------------------------------------------------------

describe('POST /api/tenants — Response Schema Stability', () => {
  describe('201 success envelope shape', () => {
    it('returns the standard top-level success envelope keys', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-create')
        .send({
          name: 'GrantFox Ops',
          slug: 'grantfox-ops',
          contactEmail: 'ops@grantfox.test',
          plan: 'growth',
          metadata: { campaign: 'fwc26' },
        })
        .expect(201);

      // Envelope-level keys must be exactly these four — nothing more, nothing less.
      const topLevelKeys = Object.keys(res.body).sort();
      expect(topLevelKeys).toEqual(['data', 'requestId', 'success', 'timestamp']);
    });

    it('returns success: true on the envelope', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-create')
        .send({ name: 'GrantFox Ops', plan: 'starter' })
        .expect(201);

      expect(res.body.success).toBe(true);
    });

    it('returns requestId echoing the x-request-id header', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-create')
        .send({ name: 'GrantFox Ops', plan: 'starter' })
        .expect(201);

      expect(res.body.requestId).toBe('req-schema-create');
    });

    it('returns a valid ISO-8601 timestamp on the envelope', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-create')
        .send({ name: 'GrantFox Ops', plan: 'starter' })
        .expect(201);

      expect(typeof res.body.timestamp).toBe('string');
      expect(new Date(res.body.timestamp).getTime()).not.toBeNaN();
    });

    it('returns a data object with the exact TenantRecord keys', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-create')
        .send({
          name: 'GrantFox Ops',
          slug: 'grantfox-ops',
          contactEmail: 'ops@grantfox.test',
          plan: 'growth',
          metadata: { campaign: 'fwc26' },
        })
        .expect(201);

      // All TenantRecord fields must be present; no extra undocumented fields.
      const dataKeys = Object.keys(res.body.data).sort();
      expect(dataKeys).toEqual([
        'contactEmail',
        'createdAt',
        'createdBy',
        'id',
        'metadata',
        'name',
        'plan',
        'slug',
        'updatedAt',
      ]);
    });

    it('returns TenantRecord fields with the correct primitive types', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-create')
        .send({
          name: 'GrantFox Ops',
          slug: 'grantfox-ops',
          contactEmail: 'ops@grantfox.test',
          plan: 'growth',
          metadata: { campaign: 'fwc26' },
        })
        .expect(201);

      const { data } = res.body;
      expect(typeof data.id).toBe('string');
      expect(typeof data.name).toBe('string');
      expect(typeof data.slug).toBe('string');
      expect(typeof data.contactEmail).toBe('string');
      expect(['starter', 'growth', 'enterprise']).toContain(data.plan);
      expect(typeof data.metadata).toBe('object');
      expect(typeof data.createdBy).toBe('string');
      expect(typeof data.createdAt).toBe('string');
      expect(typeof data.updatedAt).toBe('string');
      // Dates must parse as valid ISO-8601
      expect(new Date(data.createdAt).getTime()).not.toBeNaN();
      expect(new Date(data.updatedAt).getTime()).not.toBeNaN();
    });

    it('omits optional contactEmail and metadata fields when not supplied', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-minimal')
        .send({ name: 'Minimal Tenant' })
        .expect(201);

      // Optional fields should be absent (undefined → omitted from JSON)
      expect(Object.keys(res.body.data)).not.toContain('contactEmail');
      expect(Object.keys(res.body.data)).not.toContain('metadata');
    });
  });

  // -------------------------------------------------------------------------
  // POST — snapshot: full structural snapshot for CI schema-drift detection
  // -------------------------------------------------------------------------

  describe('snapshot — full POST /api/tenants response', () => {
    it('matches the stable full create-tenant response snapshot', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-snapshot')
        .send({
          name: 'GrantFox Ops',
          slug: 'grantfox-ops',
          contactEmail: 'ops@grantfox.test',
          plan: 'growth',
          metadata: { campaign: 'fwc26', priority: 1 },
        })
        .expect(201);

      // Stabilize non-deterministic fields before snapshotting.
      const stabilized = {
        ...res.body,
        // Replace wall-clock timestamp with a placeholder so the snapshot is
        // reproducible across test runs at different times.
        timestamp: '<TIMESTAMP>',
        data: {
          ...res.body.data,
          createdAt: '<CREATED_AT>',
          updatedAt: '<UPDATED_AT>',
        },
      };

      expect(stabilized).toMatchSnapshot('post-tenant-full-response');
    });

    it('matches the top-level shape snapshot', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-shape')
        .send({ name: 'GrantFox Ops', plan: 'starter' })
        .expect(201);

      expect({
        topLevelKeys: Object.keys(res.body).sort(),
        dataKeys: Object.keys(res.body.data).sort(),
        successValue: res.body.success,
      }).toMatchSnapshot('post-tenant-shape');
    });
  });

  // -------------------------------------------------------------------------
  // POST — 401 unauthenticated error envelope shape
  // -------------------------------------------------------------------------

  describe('401 unauthenticated — error envelope shape', () => {
    it('returns the standard error envelope when x-user-id is missing', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-request-id', 'req-schema-unauth')
        .send({ name: 'GrantFox Ops' })
        .expect(401);

      // Top-level keys of the error envelope must be exactly these.
      const topLevelKeys = Object.keys(res.body).sort();
      expect(topLevelKeys).toEqual(['error', 'requestId', 'success', 'timestamp']);

      expect(res.body.success).toBe(false);
      expect(res.body.requestId).toBe('req-schema-unauth');
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('returns error.code = UNAUTHORIZED and a non-empty message', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-request-id', 'req-schema-unauth')
        .send({ name: 'GrantFox Ops' })
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.error.message.length).toBeGreaterThan(0);
    });

    it('returns the correct error object keys (code, message — no details)', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-request-id', 'req-schema-unauth')
        .send({ name: 'GrantFox Ops' })
        .expect(401);

      const errorKeys = Object.keys(res.body.error).sort();
      // 401 errors carry no details array — only code and message.
      expect(errorKeys).toEqual(['code', 'message']);
    });
  });

  // -------------------------------------------------------------------------
  // POST — 400 validation error envelope shape
  // -------------------------------------------------------------------------

  describe('400 validation error — error envelope shape', () => {
    it('returns a VALIDATION_ERROR envelope when name is missing', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-invalid')
        .send({ contactEmail: 'not-an-email' })
        .expect(400);

      const topLevelKeys = Object.keys(res.body).sort();
      expect(topLevelKeys).toEqual(['error', 'requestId', 'success', 'timestamp']);

      expect(res.body.success).toBe(false);
      expect(res.body.requestId).toBe('req-schema-invalid');
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof res.body.error.message).toBe('string');
    });

    it('returns a details array with field-level validation errors', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-invalid')
        .send({ contactEmail: 'not-an-email' })
        .expect(400);

      // details must be an array with at least one entry
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.details.length).toBeGreaterThan(0);

      // Every detail entry must carry field, message, and code
      for (const detail of res.body.error.details) {
        expect(typeof detail.field).toBe('string');
        expect(typeof detail.message).toBe('string');
        expect(typeof detail.code).toBe('string');
      }
    });

    it('includes a body.name detail when name is absent', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-invalid')
        .send({ plan: 'starter' })
        .expect(400);

      const fields = res.body.error.details.map(
        (d: { field: string }) => d.field,
      );
      expect(fields).toContain('body.name');
    });

    it('returns VALIDATION_ERROR and details for unknown body fields (strict mode)', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-unknown')
        .send({ name: 'GrantFox Ops', unsafeRole: 'admin' })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const fields = res.body.error.details.map(
        (d: { field: string }) => d.field,
      );
      expect(fields).toContain('body');
    });

    it('matches the validation error envelope snapshot', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .post('/api/tenants')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-invalid-snap')
        .send({ contactEmail: 'bad' })
        .expect(400);

      const stabilized = {
        ...res.body,
        timestamp: '<TIMESTAMP>',
      };

      expect(stabilized).toMatchSnapshot('post-tenant-validation-error');
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/tenants/:tenantId — success and error envelope schema
// ---------------------------------------------------------------------------

describe('PATCH /api/tenants/:tenantId — Response Schema Stability', () => {
  describe('200 success envelope shape', () => {
    it('returns the standard top-level success envelope keys', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update')
        .send({ name: 'GrantFox Stadium Ops', plan: 'enterprise' })
        .expect(200);

      const topLevelKeys = Object.keys(res.body).sort();
      expect(topLevelKeys).toEqual(['data', 'requestId', 'success', 'timestamp']);
    });

    it('returns success: true on the update envelope', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update')
        .send({ plan: 'enterprise' })
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('echoes the x-request-id header in requestId', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update')
        .send({ plan: 'growth' })
        .expect(200);

      expect(res.body.requestId).toBe('req-schema-update');
    });

    it('returns a data object with the exact TenantRecord keys', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update')
        .send({
          name: 'GrantFox Stadium Ops',
          contactEmail: 'stadium@grantfox.test',
          plan: 'enterprise',
          metadata: { campaign: 'fwc26' },
        })
        .expect(200);

      const dataKeys = Object.keys(res.body.data).sort();
      expect(dataKeys).toEqual([
        'contactEmail',
        'createdAt',
        'createdBy',
        'id',
        'metadata',
        'name',
        'plan',
        'slug',
        'updatedAt',
      ]);
    });

    it('returns TenantRecord fields with the correct primitive types after update', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update')
        .send({
          name: 'GrantFox Stadium Ops',
          contactEmail: 'stadium@grantfox.test',
          plan: 'enterprise',
          metadata: { campaign: 'fwc26' },
        })
        .expect(200);

      const { data } = res.body;
      expect(typeof data.id).toBe('string');
      expect(typeof data.name).toBe('string');
      expect(typeof data.slug).toBe('string');
      expect(typeof data.contactEmail).toBe('string');
      expect(['starter', 'growth', 'enterprise']).toContain(data.plan);
      expect(typeof data.metadata).toBe('object');
      expect(typeof data.createdBy).toBe('string');
      expect(typeof data.createdAt).toBe('string');
      expect(typeof data.updatedAt).toBe('string');
      expect(new Date(data.createdAt).getTime()).not.toBeNaN();
      expect(new Date(data.updatedAt).getTime()).not.toBeNaN();
    });

    it('reflects the tenantId from the URL params in data.id', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update')
        .send({ plan: 'growth' })
        .expect(200);

      // The mock repo echoes back the tenantId as data.id
      expect(res.body.data.id).toBe('tenant-abc-001');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH — snapshot
  // -------------------------------------------------------------------------

  describe('snapshot — full PATCH /api/tenants/:tenantId response', () => {
    it('matches the stable full update-tenant response snapshot', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update-snap')
        .send({
          name: 'GrantFox Stadium Ops',
          contactEmail: 'stadium@grantfox.test',
          plan: 'enterprise',
          metadata: { campaign: 'fwc26' },
        })
        .expect(200);

      const stabilized = {
        ...res.body,
        timestamp: '<TIMESTAMP>',
        data: {
          ...res.body.data,
          createdAt: '<CREATED_AT>',
          updatedAt: '<UPDATED_AT>',
        },
      };

      expect(stabilized).toMatchSnapshot('patch-tenant-full-response');
    });

    it('matches the top-level shape snapshot', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-update-shape')
        .send({ plan: 'growth' })
        .expect(200);

      expect({
        topLevelKeys: Object.keys(res.body).sort(),
        dataKeys: Object.keys(res.body.data).sort(),
        successValue: res.body.success,
      }).toMatchSnapshot('patch-tenant-shape');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH — 401 unauthenticated
  // -------------------------------------------------------------------------

  describe('401 unauthenticated — error envelope shape', () => {
    it('returns a UNAUTHORIZED error envelope when x-user-id is missing', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-request-id', 'req-schema-patch-unauth')
        .send({ plan: 'growth' })
        .expect(401);

      const topLevelKeys = Object.keys(res.body).sort();
      expect(topLevelKeys).toEqual(['error', 'requestId', 'success', 'timestamp']);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.requestId).toBe('req-schema-patch-unauth');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH — 400 validation error envelope shape
  // -------------------------------------------------------------------------

  describe('400 validation error — error envelope shape', () => {
    it('returns VALIDATION_ERROR when body is empty (no fields supplied)', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-patch-invalid')
        .send({})
        .expect(400);

      const topLevelKeys = Object.keys(res.body).sort();
      expect(topLevelKeys).toEqual(['error', 'requestId', 'success', 'timestamp']);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.body.error.details)).toBe(true);
    });

    it('returns VALIDATION_ERROR when tenantId param is too short', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/ab')          // "ab" is only 2 chars — fails tenantIdPattern
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-patch-bad-param')
        .send({ plan: 'growth' })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const fields = res.body.error.details.map(
        (d: { field: string }) => d.field,
      );
      expect(fields).toContain('params.tenantId');
    });

    it('returns a well-formed details array for patch validation failures', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-patch-invalid')
        .send({})
        .expect(400);

      expect(res.body.error.details.length).toBeGreaterThan(0);
      for (const detail of res.body.error.details) {
        expect(typeof detail.field).toBe('string');
        expect(typeof detail.message).toBe('string');
        expect(typeof detail.code).toBe('string');
      }
    });

    it('matches the patch validation error envelope snapshot', async () => {
      const { app } = buildApp();

      const res = await request(app)
        .patch('/api/tenants/tenant-abc-001')
        .set('x-user-id', 'dev-1')
        .set('x-request-id', 'req-schema-patch-invalid-snap')
        .send({})
        .expect(400);

      const stabilized = {
        ...res.body,
        timestamp: '<TIMESTAMP>',
      };

      expect(stabilized).toMatchSnapshot('patch-tenant-validation-error');
    });
  });
});

// ---------------------------------------------------------------------------
// Repository error propagation — 500 error envelope shape
// ---------------------------------------------------------------------------

describe('500 internal server error — error envelope shape', () => {
  it('returns a stable INTERNAL_SERVER_ERROR envelope when create throws', async () => {
    const repo = new MockTenantRepository();
    (repo.create as jest.Mock).mockRejectedValueOnce(
      new Error('tenant store unavailable'),
    );
    const { app } = buildApp(repo);

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-schema-500')
      .send({ name: 'GrantFox Ops' })
      .expect(500);

    const topLevelKeys = Object.keys(res.body).sort();
    expect(topLevelKeys).toEqual(['error', 'requestId', 'success', 'timestamp']);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.requestId).toBe('req-schema-500');
  });

  it('returns a stable INTERNAL_SERVER_ERROR envelope when update throws', async () => {
    const repo = new MockTenantRepository();
    (repo.update as jest.Mock).mockRejectedValueOnce(
      new Error('tenant store unavailable'),
    );
    const { app } = buildApp(repo);

    const res = await request(app)
      .patch('/api/tenants/tenant-abc-001')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-schema-500-patch')
      .send({ plan: 'growth' })
      .expect(500);

    const topLevelKeys = Object.keys(res.body).sort();
    expect(topLevelKeys).toEqual(['error', 'requestId', 'success', 'timestamp']);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.requestId).toBe('req-schema-500-patch');
  });
});

// ---------------------------------------------------------------------------
// Cross-endpoint envelope contract invariants
// ---------------------------------------------------------------------------

describe('Envelope contract invariants — all /api/tenants responses', () => {
  /**
   * Every response from every /api/tenants handler must carry the four
   * canonical envelope fields: success, requestId, timestamp, and either
   * data (success) or error (failure).
   */
  const scenarios: Array<{
    label: string;
    method: 'post' | 'patch';
    path: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    expectedStatus: number;
  }> = [
    {
      label: 'POST success',
      method: 'post',
      path: '/api/tenants',
      headers: { 'x-user-id': 'dev-1', 'x-request-id': 'req-invariant-1' },
      body: { name: 'Invariant Tenant', plan: 'starter' },
      expectedStatus: 201,
    },
    {
      label: 'POST 401',
      method: 'post',
      path: '/api/tenants',
      headers: { 'x-request-id': 'req-invariant-2' },
      body: { name: 'Invariant Tenant' },
      expectedStatus: 401,
    },
    {
      label: 'POST 400',
      method: 'post',
      path: '/api/tenants',
      headers: { 'x-user-id': 'dev-1', 'x-request-id': 'req-invariant-3' },
      body: {},
      expectedStatus: 400,
    },
    {
      label: 'PATCH success',
      method: 'patch',
      path: '/api/tenants/tenant-abc-001',
      headers: { 'x-user-id': 'dev-1', 'x-request-id': 'req-invariant-4' },
      body: { plan: 'growth' },
      expectedStatus: 200,
    },
    {
      label: 'PATCH 401',
      method: 'patch',
      path: '/api/tenants/tenant-abc-001',
      headers: { 'x-request-id': 'req-invariant-5' },
      body: { plan: 'growth' },
      expectedStatus: 401,
    },
    {
      label: 'PATCH 400 (empty body)',
      method: 'patch',
      path: '/api/tenants/tenant-abc-001',
      headers: { 'x-user-id': 'dev-1', 'x-request-id': 'req-invariant-6' },
      body: {},
      expectedStatus: 400,
    },
  ];

  it.each(scenarios)(
    '$label carries the four mandatory envelope fields',
    async ({ method, path, headers, body, expectedStatus }) => {
      const { app } = buildApp();

      let req = request(app)[method](path);
      for (const [key, value] of Object.entries(headers)) {
        req = req.set(key, value);
      }
      const res = await req.send(body).expect(expectedStatus);

      // Every envelope — success or error — must carry these four fields.
      expect(typeof res.body.success).toBe('boolean');
      expect(typeof res.body.requestId).toBe('string');
      expect(typeof res.body.timestamp).toBe('string');
      expect(new Date(res.body.timestamp).getTime()).not.toBeNaN();

      if (res.body.success) {
        expect(res.body.data).toBeDefined();
      } else {
        expect(res.body.error).toBeDefined();
        expect(typeof res.body.error.code).toBe('string');
        expect(typeof res.body.error.message).toBe('string');
      }
    },
  );
});
