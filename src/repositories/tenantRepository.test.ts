import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { newDb } from 'pg-mem';
import { ConflictError, NotFoundError } from '../errors/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { createTenantsRouter } from '../routes/tenants.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';
import {
  InMemoryTenantRepository,
  PostgresTenantRepository,
  type TenantRepository,
  type TenantRepositoryQueryable,
} from './tenantRepository.js';

const migrationSql = fs.readFileSync(
  path.join(process.cwd(), 'migrations', '0034_tenants.sql'),
  'utf8',
);

function createPgPool() {
  const db = newDb();
  db.public.none(migrationSql);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return pool as unknown as TenantRepositoryQueryable & { end(): Promise<void> };
}

function authHeader(userId = 'dev-1') {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  return `Bearer ${signTestToken({ userId })}`;
}

interface RepoFactory {
  name: string;
  create: () => { repo: TenantRepository; cleanup: () => Promise<void> };
}

const factories: RepoFactory[] = [
  {
    name: 'InMemoryTenantRepository',
    create: () => ({
      repo: new InMemoryTenantRepository(),
      cleanup: async () => undefined,
    }),
  },
  {
    name: 'PostgresTenantRepository',
    create: () => {
      const pool = createPgPool();
      return {
        repo: new PostgresTenantRepository(pool),
        cleanup: () => pool.end(),
      };
    },
  },
];

describe.each(factories)('$name', ({ create }) => {
  let repo: TenantRepository;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const instance = create();
    repo = instance.repo;
    cleanup = instance.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('creates a tenant with generated id and slug, and omits optional fields when absent', async () => {
    const created = await repo.create({ name: 'AI', plan: 'starter' }, 'dev-1');

    expect(created.id).toMatch(/^ten_/);
    expect(created.name).toBe('AI');
    expect(created.slug).toBe('tenant-ai');
    expect(created.plan).toBe('starter');
    expect(created.createdBy).toBe('dev-1');
    expect(created.contactEmail).toBeUndefined();
    expect(created.metadata).toBeUndefined();
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it('round-trips metadata JSON with string, number, and boolean values', async () => {
    const metadata = { campaign: 'fwc26', tier: 2, active: true };
    const created = await repo.create(
      {
        name: 'GrantFox Ops',
        slug: 'grantfox-ops',
        contactEmail: 'ops@grantfox.test',
        plan: 'growth',
        metadata,
      },
      'dev-1',
    );

    expect(created.contactEmail).toBe('ops@grantfox.test');
    expect(created.metadata).toEqual(metadata);

    const listed = await repo.list('dev-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata).toEqual(metadata);
    expect(listed[0]?.contactEmail).toBe('ops@grantfox.test');
  });

  it('lists only the requesting actor\'s tenants', async () => {
    const own = await repo.create({ name: 'Own Tenant', plan: 'starter' }, 'dev-1');
    await repo.create({ name: 'Other Tenant', plan: 'growth' }, 'dev-2');

    const listDev1 = await repo.list('dev-1');
    expect(listDev1).toHaveLength(1);
    expect(listDev1[0]?.id).toBe(own.id);

    const listDev3 = await repo.list('dev-3');
    expect(listDev3).toEqual([]);
  });

  it('throws ConflictError on duplicate slug', async () => {
    await repo.create({ name: 'GrantFox Ops', slug: 'grantfox-ops', plan: 'starter' }, 'dev-1');

    await expect(
      repo.create({ name: 'Another Name', slug: 'grantfox-ops', plan: 'growth' }, 'dev-2'),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      name: ConflictError.name,
    });
  });

  it('merges partial updates and bumps updatedAt without mutating other fields', async () => {
    const created = await repo.create(
      {
        name: 'GrantFox Ops',
        slug: 'grantfox-ops',
        contactEmail: 'ops@grantfox.test',
        plan: 'starter',
        metadata: { region: 'us' },
      },
      'dev-1',
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(
      created.id,
      { plan: 'enterprise', metadata: { region: 'eu', seats: 50 } },
      'dev-1',
    );

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('GrantFox Ops');
    expect(updated.slug).toBe('grantfox-ops');
    expect(updated.contactEmail).toBe('ops@grantfox.test');
    expect(updated.plan).toBe('enterprise');
    expect(updated.metadata).toEqual({ region: 'eu', seats: 50 });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );
  });

  it('throws identical NotFoundError for unknown id and cross-actor update', async () => {
    const foreign = await repo.create({ name: 'Foreign Tenant', plan: 'starter' }, 'dev-2');

    let unknownErr: unknown;
    try {
      await repo.update('ten_does_not_exist', { name: 'Nope' }, 'dev-1');
    } catch (err) {
      unknownErr = err;
    }

    let crossActorErr: unknown;
    try {
      await repo.update(foreign.id, { name: 'Takeover' }, 'dev-1');
    } catch (err) {
      crossActorErr = err;
    }

    expect(unknownErr).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Tenant not found',
      name: NotFoundError.name,
    });
    expect(crossActorErr).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Tenant not found',
      name: NotFoundError.name,
    });
  });
});

describe('PostgresTenantRepository HTTP integration', () => {
  function buildPgApp(pool: TenantRepositoryQueryable) {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/tenants', createTenantsRouter({ pool }));
    app.use(errorHandler);
    return app;
  }

  it('persists tenants across app restarts and returns 409 on duplicate slug and identical 404 on cross-actor PATCH', async () => {
    const pool = createPgPool();

    try {
      const appBeforeRestart = buildPgApp(pool);

      const created = await request(appBeforeRestart)
        .post('/api/tenants')
        .set('Authorization', authHeader('dev-1'))
        .send({
          name: 'Persistent Tenant',
          slug: 'persistent-tenant',
          plan: 'growth',
          metadata: { env: 'prod', version: 1, active: true },
        });

      expect(created.status).toBe(201);

      // Duplicate slug returns 409 CONFLICT rather than 500
      const duplicate = await request(appBeforeRestart)
        .post('/api/tenants')
        .set('Authorization', authHeader('dev-2'))
        .send({ name: 'Duplicate', slug: 'persistent-tenant' });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('CONFLICT');

      // Simulate app restart with a fresh router instance backed by the same pool
      const appAfterRestart = buildPgApp(pool);
      const listed = await request(appAfterRestart)
        .get('/api/tenants')
        .set('Authorization', authHeader('dev-1'));

      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0]).toEqual(created.body.data);

      // Cross-actor PATCH returns 404 with the same body as an unknown id
      const crossActor = await request(appAfterRestart)
        .patch(`/api/tenants/${created.body.data.id}`)
        .set('Authorization', authHeader('dev-2'))
        .set('x-request-id', 'req-same')
        .send({ name: 'Takeover' });

      const unknown = await request(appAfterRestart)
        .patch('/api/tenants/ten_unknown_id')
        .set('Authorization', authHeader('dev-2'))
        .set('x-request-id', 'req-same')
        .send({ name: 'Takeover' });

      expect(crossActor.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(crossActor.body.error).toEqual(unknown.body.error);
    } finally {
      await pool.end();
    }
  });
});
