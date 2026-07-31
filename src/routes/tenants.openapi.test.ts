/**
 * Contract tests for src/openapi.yaml — /api/tenants surface.
 *
 * Validates that the examples added for GrantFox FWC26 cover:
 *   - POST /api/tenants  (create with Zod validation + structured 400s)
 *   - GET  /api/tenants  (list with ETag support)
 *   - PATCH /api/tenants/{tenantId}  (update with per-field + param errors)
 *
 * Follows the same pattern used by src/routes/spike.openapi.test.ts:
 * read the YAML file as a string and assert the presence of key strings so
 * the tests remain stable without a full YAML parse dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { logger } from '../logger.js';
import { createTenantsRouter, type TenantRecord, type TenantRepository } from './tenants.js';
import type { CreateTenantInput, UpdateTenantInput } from '../validators/tenants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const yamlPath = path.join(process.cwd(), 'src', 'openapi.yaml');

function readOpenApiYaml(): string {
  return fs.readFileSync(yamlPath, 'utf8');
}

class MockTenantRepository implements TenantRepository {
  list = jest.fn(async (): Promise<TenantRecord[]> => [
    {
      id: 'ten_a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'GrantFox Ops',
      slug: 'grantfox-ops',
      contactEmail: 'ops@grantfox.test',
      plan: 'growth',
      metadata: { campaign: 'fwc26' },
      createdBy: 'dev-1',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
  ]);

  create = jest.fn(async (input: CreateTenantInput, actorId: string): Promise<TenantRecord> => ({
    id: 'ten_a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: input.name,
    slug: input.slug ?? 'grantfox-ops',
    contactEmail: input.contactEmail,
    plan: input.plan,
    metadata: input.metadata,
    createdBy: actorId,
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  }));

  update = jest.fn(async (tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord> => ({
    id: tenantId,
    name: input.name ?? 'GrantFox Ops',
    slug: 'grantfox-ops',
    contactEmail: input.contactEmail,
    plan: input.plan ?? 'starter',
    metadata: input.metadata,
    createdBy: actorId,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T11:00:00.000Z',
  }));
}

function buildApp(repository = new MockTenantRepository()) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/tenants', createTenantsRouter({ tenantRepository: repository }));
  app.use(errorHandler);
  return { app, repository };
}

// ---------------------------------------------------------------------------
// Group 1 — OpenAPI YAML contract (string-presence assertions)
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — /api/tenants surface', () => {
  test('documents /api/tenants and /api/tenants/{tenantId} paths', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('/api/tenants:');
    expect(content).toContain('/api/tenants/{tenantId}:');
  });

  test('documents GET /api/tenants list and ETag examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('List tenants');
    expect(content).toContain('withTenants:');
    expect(content).toContain('empty:');
    // ETag conditional-GET
    expect(content).toContain('If-None-Match');
    expect(content).toContain('304');
  });

  test('documents POST /api/tenants create request and success example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('Create a tenant');
    expect(content).toContain('createFull:');
    expect(content).toContain('createMinimal:');
    expect(content).toContain('created:');
    // Zod-validation callout in description
    expect(content).toContain('Zod-validated');
  });

  test('documents structured 400 validation-error examples for POST', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('missingName:');
    expect(content).toContain('VALIDATION_ERROR');
    expect(content).toContain('name is required');
    expect(content).toContain('invalidEmail:');
    expect(content).toContain('contactEmail must be a valid email address');
    expect(content).toContain('unknownKey:');
    expect(content).toContain('UNRECOGNIZED_KEYS');
    expect(content).toContain('invalidPlan:');
    expect(content).toContain('INVALID_ENUM_VALUE');
  });

  test('documents PATCH /api/tenants/{tenantId} update request and success example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('Update a tenant');
    expect(content).toContain('updatePlan:');
    expect(content).toContain('updateContactEmail:');
    expect(content).toContain('updateMultiple:');
    expect(content).toContain('updated:');
  });

  test('documents combined param + body 400 example for PATCH', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('invalidParamAndEmptyBody:');
    expect(content).toContain('At least one tenant field must be provided');
    expect(content).toContain('params.tenantId');
    expect(content).toContain('unknownKey:');
  });

  test('documents 401 examples for all tenant operations', () => {
    const content = readOpenApiYaml();

    // Multiple 401 blocks — one per operation
    const matches = [...content.matchAll(/code: UNAUTHORIZED/g)];
    // At minimum POST, GET, and PATCH each contribute one UNAUTHORIZED block
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test('defines typed tenant schemas in components', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('TenantRecord:');
    expect(content).toContain('TenantCreateRequest:');
    expect(content).toContain('TenantUpdateRequest:');
    expect(content).toContain('TenantResponse:');
    expect(content).toContain('TenantListResponse:');
    expect(content).toContain('TenantPlan:');
    expect(content).toContain('TenantMetadata:');
    // Plan enum values
    expect(content).toContain('enum: [starter, growth, enterprise]');
  });
});

// ---------------------------------------------------------------------------
// Group 2 — HTTP integration: Zod validation produces structured 400s
// ---------------------------------------------------------------------------

describe('POST /api/tenants — Zod validation integration', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns 400 with VALIDATION_ERROR and per-field details when name is missing', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-missing-name')
      .send({ contactEmail: 'bad-email' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' },
      requestId: 'req-missing-name',
    });
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.name' }),
        expect.objectContaining({ field: 'body.contactEmail' }),
      ]),
    );
  });

  it('returns 400 with UNRECOGNIZED_KEYS when unknown fields are sent', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-unknown-key')
      .send({ name: 'GrantFox Ops', unsafeRole: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body', code: 'UNRECOGNIZED_KEYS' }),
      ]),
    );
  });

  it('returns 400 when plan is outside the allowed enum', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-bad-plan')
      .send({ name: 'GrantFox Ops', plan: 'premium' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.plan' }),
      ]),
    );
  });

  it('returns 201 success envelope for a valid minimal create request', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-create-ok')
      .send({ name: 'GrantFox Stadium' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      requestId: 'req-create-ok',
      data: expect.objectContaining({ name: 'GrantFox Stadium' }),
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GrantFox Stadium', plan: 'starter' }),
      'dev-1',
    );
  });

  it('returns 201 with trimmed name and lowercased slug', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .send({ name: '  GrantFox Ops  ', slug: 'GrantFox-Ops', plan: 'growth' });

    expect(res.status).toBe(201);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GrantFox Ops', slug: 'grantfox-ops' }),
      'dev-1',
    );
  });

  it('returns 401 before validation when request is unauthenticated', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .send({ name: 'GrantFox Ops' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(repository.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group 3 — HTTP integration: PATCH validation collects param + body errors
// ---------------------------------------------------------------------------

describe('PATCH /api/tenants/:tenantId — Zod validation integration', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns 400 collecting param and body errors in one pass', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .patch('/api/tenants/no')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-patch-multi-error')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe('req-patch-multi-error');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body' }),
        expect.objectContaining({ field: 'params.tenantId' }),
      ]),
    );
  });

  it('returns 400 when slug is sent (strict schema — not an update field)', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .patch('/api/tenants/tenant_123')
      .set('x-user-id', 'dev-1')
      .send({ slug: 'new-slug' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNRECOGNIZED_KEYS' }),
      ]),
    );
  });

  it('returns 200 success envelope for a valid update', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .patch('/api/tenants/tenant_123')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-patch-ok')
      .send({ plan: 'enterprise' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      requestId: 'req-patch-ok',
      data: expect.objectContaining({ id: 'tenant_123', plan: 'enterprise' }),
    });
    expect(repository.update).toHaveBeenCalledWith(
      'tenant_123',
      expect.objectContaining({ plan: 'enterprise' }),
      'dev-1',
    );
  });

  it('returns 401 before validation when unauthenticated', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .patch('/api/tenants/tenant_123')
      .send({ plan: 'enterprise' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(repository.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group 4 — HTTP integration: GET /api/tenants
// ---------------------------------------------------------------------------

describe('GET /api/tenants — list integration', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns 200 success envelope with tenant array', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-list-ok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      requestId: 'req-list-ok',
    });
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('sets a strong ETag header on the list response', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('returns 304 when If-None-Match matches the ETag', async () => {
    const { app } = buildApp();

    const first = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;

    const second = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
  });

  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/tenants');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
