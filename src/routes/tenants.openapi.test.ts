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

type JsonObject = Record<string, unknown>;

const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

function readSpec(): JsonObject {
  return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
}

function asObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function responseExamples(operation: JsonObject, status: string): JsonObject {
  const response = asObject(asObject(operation.responses)[status]);
  const content = asObject(response.content);
  return asObject(asObject(content['application/json']).examples);
}

function requestExamples(operation: JsonObject): JsonObject {
  const requestBody = asObject(operation.requestBody);
  const content = asObject(requestBody.content);
  return asObject(asObject(content['application/json']).examples);
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
// Group 1 — OpenAPI JSON contract
// ---------------------------------------------------------------------------

describe('docs/openapi.json — /api/tenants surface', () => {
  test('documents /api/tenants and /api/tenants/{tenantId} paths', () => {
    const paths = asObject(readSpec().paths);

    expect(asObject(paths['/api/tenants'])).toHaveProperty('get');
    expect(asObject(paths['/api/tenants'])).toHaveProperty('post');
    expect(asObject(paths['/api/tenants/{tenantId}'])).toHaveProperty('patch');
  });

  test('documents GET /api/tenants list and ETag examples', () => {
    const paths = asObject(readSpec().paths);
    const operation = asObject(asObject(paths['/api/tenants']).get);
    const examples = responseExamples(operation, '200');
    const responses = asObject(operation.responses);

    expect(operation.summary).toBe('List tenants');
    expect(examples).toHaveProperty('withTenants');
    expect(examples).toHaveProperty('empty');
    expect((operation.parameters as JsonObject[]).map((parameter) => parameter.name)).toContain('If-None-Match');
    expect(responses).toHaveProperty('304');
  });

  test('documents POST /api/tenants create request and success example', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/tenants']).post);
    const examples = requestExamples(operation);
    const successExamples = responseExamples(operation, '201');

    expect(operation.summary).toBe('Create a tenant');
    expect(operation.description).toContain('Zod-validated');
    expect(examples).toHaveProperty('createFull');
    expect(examples).toHaveProperty('createMinimal');
    expect(successExamples).toHaveProperty('created');
  });

  test('documents structured 400 validation-error examples for POST', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/tenants']).post);
    const examples = responseExamples(operation, '400');

    for (const name of ['missingName', 'invalidEmail', 'unknownKey', 'invalidPlan']) {
      expect(examples[name]).toBeDefined();
      expect(asObject(asObject(examples[name]).value).error).toEqual(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
    expect(JSON.stringify(examples.missingName)).toContain('name is required');
    expect(JSON.stringify(examples.invalidEmail)).toContain('contactEmail must be a valid email address');
    expect(JSON.stringify(examples.unknownKey)).toContain('UNRECOGNIZED_KEYS');
    expect(JSON.stringify(examples.invalidPlan)).toContain('INVALID_ENUM_VALUE');
  });

  test('documents PATCH /api/tenants/{tenantId} update request and success example', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/tenants/{tenantId}']).patch);
    const examples = requestExamples(operation);
    const successExamples = responseExamples(operation, '200');

    expect(operation.summary).toBe('Update a tenant');
    for (const name of ['updatePlan', 'updateContactEmail', 'updateMultiple']) {
      expect(examples[name]).toBeDefined();
    }
    expect(successExamples).toHaveProperty('updated');
  });

  test('documents combined param + body 400 example for PATCH', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/tenants/{tenantId}']).patch);
    const examples = responseExamples(operation, '400');

    expect(JSON.stringify(examples.invalidParamAndEmptyBody)).toContain('At least one tenant field must be provided');
    expect(JSON.stringify(examples.invalidParamAndEmptyBody)).toContain('params.tenantId');
    expect(examples).toHaveProperty('unknownKey');
  });

  test('documents 401 examples for all tenant operations', () => {
    const paths = asObject(readSpec().paths);
    const getExamples = responseExamples(asObject(asObject(paths['/api/tenants']).get), '401');
    const postExamples = responseExamples(asObject(asObject(paths['/api/tenants']).post), '401');
    const patchExamples = responseExamples(asObject(asObject(paths['/api/tenants/{tenantId}']).patch), '401');

    for (const examples of [getExamples, postExamples, patchExamples]) {
      expect(asObject(asObject(examples.unauthorized).value).error).toEqual(
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
      );
    }
  });

  test('defines typed tenant schemas in components', () => {
    const schemas = asObject(asObject(readSpec().components).schemas);

    for (const name of [
      'TenantRecord',
      'TenantCreateRequest',
      'TenantUpdateRequest',
      'TenantResponse',
      'TenantListResponse',
      'TenantPlan',
      'TenantMetadata',
    ]) {
      expect(schemas[name]).toBeDefined();
    }
    expect(asObject(schemas.TenantPlan).enum).toEqual(['starter', 'growth', 'enterprise']);
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
