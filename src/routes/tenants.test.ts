import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { logger } from '../logger.js';
import {
  createTenantsRouter,
  type TenantRecord,
  type TenantRepository,
} from './tenants.js';
import type { CreateTenantInput, UpdateTenantInput } from '../validators/tenants.js';

class MockTenantRepository implements TenantRepository {
  list = jest.fn(async (): Promise<TenantRecord[]> => ([
    {
      id: 'ten_test_123',
      name: 'GrantFox Ops',
      slug: 'grantfox-ops',
      plan: 'growth',
      createdBy: 'dev-1',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
    {
      id: 'ten_test_456',
      name: 'GrantFox Stadium',
      slug: 'grantfox-stadium',
      plan: 'enterprise',
      createdBy: 'dev-1',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
  ]));

  create = jest.fn(async (input: CreateTenantInput, actorId: string): Promise<TenantRecord> => ({
    id: 'ten_test_123',
    name: input.name,
    slug: input.slug ?? 'grantfox-ops',
    contactEmail: input.contactEmail,
    plan: input.plan,
    metadata: input.metadata,
    createdBy: actorId,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
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
    updatedAt: '2026-07-28T01:00:00.000Z',
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

function buildDefaultRepositoryApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/tenants', createTenantsRouter());
  app.use(errorHandler);
  return app;
}

describe('createTenantsRouter', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns 401 before validation when unauthenticated', async () => {
    const { app, repository } = buildApp();

    const res = await request(app).post('/api/tenants').send({});

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('creates a tenant with parsed input and structured success envelope', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-tenant-create')
      .set('x-correlation-id', 'corr-tenant-create')
      .send({
        name: '  GrantFox Ops  ',
        slug: 'GrantFox-Ops',
        contactEmail: 'ops@grantfox.test',
        plan: 'growth',
        metadata: { campaign: 'fwc26' },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        id: 'ten_test_123',
        name: 'GrantFox Ops',
        slug: 'grantfox-ops',
        plan: 'growth',
      },
      requestId: 'req-tenant-create',
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'GrantFox Ops', slug: 'grantfox-ops' }),
      'dev-1',
    );
    expect(infoSpy).toHaveBeenCalledWith(
      '[tenants] tenant created',
      expect.objectContaining({
        requestId: 'req-tenant-create',
        correlationId: 'corr-tenant-create',
        tenantId: 'ten_test_123',
        actorId: 'dev-1',
      }),
    );
  });

  it('returns structured 400 for invalid create body', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-invalid-create')
      .send({ contactEmail: 'bad-email' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
      },
      requestId: 'req-invalid-create',
    });
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.name' }),
        expect.objectContaining({ field: 'body.contactEmail' }),
      ]),
    );
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('returns structured 400 for unknown create fields', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .send({ name: 'GrantFox Ops', unsafeRole: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body', code: 'UNRECOGNIZED_KEYS' }),
      ]),
    );
  });

  it('updates a tenant with validated params and body', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .patch('/api/tenants/tenant_123')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-tenant-update')
      .send({ name: 'GrantFox Stadium Ops', plan: 'enterprise' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'tenant_123',
      name: 'GrantFox Stadium Ops',
      plan: 'enterprise',
    });
    expect(repository.update).toHaveBeenCalledWith(
      'tenant_123',
      expect.objectContaining({ name: 'GrantFox Stadium Ops', plan: 'enterprise' }),
      'dev-1',
    );
  });

  it('returns structured 400 for invalid patch params and empty body', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .patch('/api/tenants/no')
      .set('x-user-id', 'dev-1')
      .set('x-request-id', 'req-invalid-update')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe('req-invalid-update');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body' }),
        expect.objectContaining({ field: 'params.tenantId' }),
      ]),
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('uses the default repository to create and update tenants', async () => {
    const app = buildDefaultRepositoryApp();

    const created = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .send({ name: 'AI' });

    expect(created.status).toBe(201);
    expect(created.body.data).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^ten_/),
        name: 'AI',
        slug: 'tenant-ai',
        plan: 'starter',
        createdBy: 'dev-1',
      }),
    );

    const updated = await request(app)
      .patch(`/api/tenants/${created.body.data.id}`)
      .set('x-user-id', 'dev-1')
      .send({ contactEmail: 'ai-ops@grantfox.test' });

    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual(
      expect.objectContaining({
        id: created.body.data.id,
        name: 'AI',
        slug: 'tenant-ai',
        contactEmail: 'ai-ops@grantfox.test',
      }),
    );
  });

  it('does not list or update another developer\'s tenant', async () => {
    const app = buildDefaultRepositoryApp();
    const own = await request(app).post('/api/tenants').set('x-user-id', 'dev-1').send({ name: 'Own tenant' });
    const foreign = await request(app).post('/api/tenants').set('x-user-id', 'dev-2').send({ name: 'Foreign tenant' });

    const list = await request(app).get('/api/tenants').set('x-user-id', 'dev-1');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(own.body.data.id);

    const crossTenantUpdate = await request(app)
      .patch(`/api/tenants/${foreign.body.data.id}`)
      .set('x-user-id', 'dev-1')
      .send({ name: 'Attempted takeover' });
    expect(crossTenantUpdate.status).toBe(404);
    expect(crossTenantUpdate.body.error.code).toBe('NOT_FOUND');
  });

  it('routes repository errors through the error handler', async () => {
    const repository = new MockTenantRepository();
    repository.create.mockRejectedValueOnce(new Error('tenant store unavailable'));
    const { app } = buildApp(repository);

    const res = await request(app)
      .post('/api/tenants')
      .set('x-user-id', 'dev-1')
      .send({ name: 'GrantFox Ops' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('routes update repository errors through the error handler', async () => {
    const repository = new MockTenantRepository();
    repository.update.mockRejectedValueOnce(new Error('tenant store unavailable'));
    const { app } = buildApp(repository);

    const res = await request(app)
      .patch('/api/tenants/tenant_123')
      .set('x-user-id', 'dev-1')
      .send({ name: 'GrantFox Ops' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  // ---------------------------------------------------------------------------
  // GET / — list tenants with ETag / 304
  // ---------------------------------------------------------------------------

  it('returns 401 for GET when unauthenticated', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/tenants');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 200 with list of tenants in envelope', async () => {
    const { app, repository } = buildApp();

    const res = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ id: 'ten_test_123', name: 'GrantFox Ops' });
    expect(res.body.data[1]).toMatchObject({ id: 'ten_test_456', name: 'GrantFox Stadium' });
    expect(repository.list).toHaveBeenCalled();
  });

  it('sets a strong ETag header on GET response', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('returns 304 Not Modified when If-None-Match matches the ETag', async () => {
    const { app } = buildApp();

    const first = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();

    const second = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns 200 when If-None-Match does not match the ETag', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('If-None-Match', '"different-hash-value"');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('does not return 304 for a weak ETag (strong comparison)', async () => {
    const { app } = buildApp();

    const first = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    const weakTag = `W/${etag}`;

    const second = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1')
      .set('If-None-Match', weakTag);

    expect(second.status).toBe(200);
  });

  it('routes list repository errors through the error handler', async () => {
    const repository = new MockTenantRepository();
    repository.list.mockRejectedValueOnce(new Error('tenant store unavailable'));
    const { app } = buildApp(repository);

    const res = await request(app)
      .get('/api/tenants')
      .set('x-user-id', 'dev-1');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });
});
