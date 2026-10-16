/**
 * Tests for dispute-resolution flow (#463, #1243).
 *
 * Covers:
 *   - openDisputeSchema / resolveDisputeSchema validation
 *   - InMemoryDisputeRepository state machine + audit trail
 *   - PgDisputeRepository Postgres persistence (pg-mem against migrations/0019_disputes.sql)
 *   - DisputeService RBAC helpers (sync and async repositories)
 *   - HTTP endpoints: open, list, get, resolve, admin list
 *   - Auth enforcement on every route
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import { newDb } from 'pg-mem';
import supertest from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createDisputesRouter } from './disputes.js';
import {
  openDisputeSchema,
  resolveDisputeSchema,
  InMemoryDisputeRepository,
  PgDisputeRepository,
  DisputeService,
  type DisputeDb,
} from '../../services/disputeService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-disputes';
process.env.JWT_SECRET = JWT_SECRET;

function signUserToken(userId: string): string {
  return jwt.sign({ userId, sub: userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function wrapAgent(agent: ReturnType<typeof supertest>) {
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  return new Proxy(agent, {
    get(target, prop, receiver) {
      if (methods.includes(prop as (typeof methods)[number])) {
        const orig = Reflect.get(target, prop, receiver).bind(target);
        return (...args: unknown[]) => {
          const req = orig(...args);
          const origSet = req.set.bind(req);
          req.set = (field: string | Record<string, string>, val?: string) => {
            if (typeof field === 'string' && field.toLowerCase() === 'x-user-id' && typeof val === 'string') {
              return origSet('Authorization', `Bearer ${signUserToken(val)}`);
            }
            return origSet(field, val as string);
          };
          return req;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const request = ((app: express.Express) => wrapAgent(supertest(app))) as unknown as typeof supertest;

function buildApp(svc?: DisputeService) {
  const app = express();
  app.use(express.json());
  app.use('/api/billing/disputes', createDisputesRouter({ disputeService: svc }));
  app.use(errorHandler);
  return app;
}

function makeSvc() {
  const repo = new InMemoryDisputeRepository();
  return { svc: new DisputeService(repo), repo };
}

function createPgMemDisputeDb(): DisputeDb {
  const mem = newDb();
  const migrationPath = path.resolve(process.cwd(), 'migrations/0019_disputes.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  mem.public.none(sql);
  const pgAdapter = mem.adapters.createPg();
  const pool = new pgAdapter.Pool();
  return pool as unknown as DisputeDb;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('openDisputeSchema', () => {
  it('accepts valid input', () => {
    expect(() => openDisputeSchema.parse({ usage_event_id: 'evt-1', reason: 'Wrong charge' })).not.toThrow();
  });
  it('rejects missing usage_event_id', () => {
    expect(() => openDisputeSchema.parse({ reason: 'x' })).toThrow();
  });
  it('rejects empty reason', () => {
    expect(() => openDisputeSchema.parse({ usage_event_id: 'e', reason: '' })).toThrow();
  });
});

describe('resolveDisputeSchema', () => {
  it('accepts REFUNDED', () => {
    expect(() => resolveDisputeSchema.parse({ resolution: 'REFUNDED' })).not.toThrow();
  });
  it('accepts UPHELD with notes', () => {
    expect(() => resolveDisputeSchema.parse({ resolution: 'UPHELD', notes: 'ok' })).not.toThrow();
  });
  it('rejects invalid resolution', () => {
    expect(() => resolveDisputeSchema.parse({ resolution: 'CANCELLED' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// InMemoryDisputeRepository
// ---------------------------------------------------------------------------

describe('InMemoryDisputeRepository', () => {
  let repo: InMemoryDisputeRepository;

  beforeEach(() => { repo = new InMemoryDisputeRepository(); });

  it('creates a dispute in OPEN state', () => {
    const d = repo.create({ usage_event_id: 'evt-1', reason: 'bad charge' }, 'user-1');
    expect(d.status).toBe('OPEN');
    expect(d.opened_by).toBe('user-1');
    expect(d.resolved_at).toBeNull();
  });

  it('throws ConflictError on duplicate usage_event_id', () => {
    repo.create({ usage_event_id: 'evt-1', reason: 'x' }, 'user-1');
    expect(() => repo.create({ usage_event_id: 'evt-1', reason: 'y' }, 'user-2')).toThrow(/already exists/);
  });

  it('findById returns undefined for unknown id', () => {
    expect(repo.findById('ghost')).toBeUndefined();
  });

  it('findByUser returns only that user disputes', () => {
    repo.create({ usage_event_id: 'e1', reason: 'x' }, 'user-1');
    repo.create({ usage_event_id: 'e2', reason: 'y' }, 'user-2');
    expect(repo.findByUser('user-1')).toHaveLength(1);
  });

  it('listAll returns all disputes', () => {
    repo.create({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    repo.create({ usage_event_id: 'e2', reason: 'y' }, 'u2');
    expect(repo.listAll()).toHaveLength(2);
  });

  describe('resolve', () => {
    it('transitions OPEN → REFUNDED', () => {
      const d = repo.create({ usage_event_id: 'e1', reason: 'x' }, 'u1');
      const resolved = repo.resolve(d.id, 'REFUNDED', 'admin-1');
      expect(resolved.status).toBe('REFUNDED');
      expect(resolved.resolved_by).toBe('admin-1');
      expect(resolved.resolved_at).not.toBeNull();
    });

    it('transitions OPEN → UPHELD', () => {
      const d = repo.create({ usage_event_id: 'e1', reason: 'x' }, 'u1');
      const resolved = repo.resolve(d.id, 'UPHELD', 'admin-1');
      expect(resolved.status).toBe('UPHELD');
    });

    it('throws NotFoundError for unknown id', () => {
      expect(() => repo.resolve('ghost', 'REFUNDED', 'admin')).toThrow(/not found/);
    });

    it('throws ConflictError when already resolved', () => {
      const d = repo.create({ usage_event_id: 'e1', reason: 'x' }, 'u1');
      repo.resolve(d.id, 'UPHELD', 'admin');
      expect(() => repo.resolve(d.id, 'REFUNDED', 'admin')).toThrow(/already/);
    });
  });

  describe('audit trail', () => {
    it('appends and retrieves events', () => {
      const d = repo.create({ usage_event_id: 'e1', reason: 'x' }, 'u1');
      repo.appendEvent({ dispute_id: d.id, actor: 'u1', action: 'OPENED' });
      const events = repo.getEvents(d.id);
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('OPENED');
    });

    it('returns empty array for dispute with no events', () => {
      const d = repo.create({ usage_event_id: 'e1', reason: 'x' }, 'u1');
      expect(repo.getEvents(d.id)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// PgDisputeRepository (Postgres contract tests against 0019_disputes.sql)
// ---------------------------------------------------------------------------

describe('PgDisputeRepository (Postgres persistence)', () => {
  let repo: PgDisputeRepository;
  let svc: DisputeService;

  beforeEach(() => {
    const db = createPgMemDisputeDb();
    repo = new PgDisputeRepository(db);
    svc = new DisputeService(repo);
  });

  it('creates a dispute in OPEN state and retrieves it by id', async () => {
    const created = await repo.create({ usage_event_id: 'pg-evt-1', reason: 'double deduction' }, 'dev-1');
    expect(created.status).toBe('OPEN');
    expect(created.opened_by).toBe('dev-1');
    expect(created.usage_event_id).toBe('pg-evt-1');
    expect(created.resolved_at).toBeNull();

    const fetched = await repo.findById(created.id);
    expect(fetched).toEqual(created);
  });

  it('throws ConflictError on duplicate usage_event_id', async () => {
    await repo.create({ usage_event_id: 'pg-evt-dup', reason: 'first' }, 'dev-1');
    await expect(
      repo.create({ usage_event_id: 'pg-evt-dup', reason: 'second' }, 'dev-2'),
    ).rejects.toThrow(/already exists/);
  });

  it('findByUser and listAll return persisted disputes', async () => {
    await repo.create({ usage_event_id: 'pg-e1', reason: 'r1' }, 'dev-1');
    await repo.create({ usage_event_id: 'pg-e2', reason: 'r2' }, 'dev-2');

    const dev1Disputes = await repo.findByUser('dev-1');
    expect(dev1Disputes).toHaveLength(1);
    expect(dev1Disputes[0].opened_by).toBe('dev-1');

    const all = await repo.listAll();
    expect(all).toHaveLength(2);
  });

  it('transitions OPEN → REFUNDED and persists resolution_notes', async () => {
    const created = await repo.create({ usage_event_id: 'pg-e-ref', reason: 'timeout' }, 'dev-1');
    const resolved = await repo.resolve(created.id, 'REFUNDED', 'admin-user', 'refund approved');
    expect(resolved.status).toBe('REFUNDED');
    expect(resolved.resolved_by).toBe('admin-user');
    expect(resolved.resolution_notes).toBe('refund approved');
    expect(resolved.resolved_at).not.toBeNull();

    await expect(repo.resolve(created.id, 'UPHELD', 'admin-user')).rejects.toThrow(/already/);
  });

  it('persists dispute_events audit trail end-to-end through DisputeService and HTTP routes', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const app = buildApp(svc);

    const openRes = await request(app)
      .post('/api/billing/disputes')
      .set('x-user-id', 'dev-pg-1')
      .send({ usage_event_id: 'pg-http-evt-1', reason: 'upstream 502 charged' });
    expect(openRes.status).toBe(201);
    expect(openRes.body.status).toBe('OPEN');

    const disputeId = openRes.body.id as string;

    const resolveRes = await request(app)
      .post(`/api/billing/disputes/${disputeId}/resolve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'REFUNDED', notes: 'verified upstream 502' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.status).toBe('REFUNDED');
    expect(resolveRes.body.resolution_notes).toBe('verified upstream 502');

    const detailRes = await request(app)
      .get(`/api/billing/disputes/${disputeId}`)
      .set('x-user-id', 'dev-pg-1');
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.dispute.status).toBe('REFUNDED');
    expect(detailRes.body.events).toHaveLength(2);
    expect(detailRes.body.events[0].action).toBe('OPENED');
    expect(detailRes.body.events[1].action).toBe('RESOLVED');
  });
});

// ---------------------------------------------------------------------------
// DisputeService
// ---------------------------------------------------------------------------

describe('DisputeService', () => {
  it('openDispute creates dispute and appends OPENED event', () => {
    const { svc, repo } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    expect(d.status).toBe('OPEN');
    expect(repo.getEvents(d.id).some(e => e.action === 'OPENED')).toBe(true);
  });

  it('resolveDispute updates status and appends RESOLVED event', () => {
    const { svc, repo } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const resolved = svc.resolveDispute(d.id, { resolution: 'REFUNDED' }, 'admin') as ReturnType<InMemoryDisputeRepository['create']>;
    expect(resolved.status).toBe('REFUNDED');
    expect(repo.getEvents(d.id).some(e => e.action === 'RESOLVED')).toBe(true);
  });

  it('getDisputeForDeveloper throws ForbiddenError for wrong user', () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    expect(() => svc.getDisputeForDeveloper(d.id, 'u2')).toThrow(/do not have access/);
  });

  it('getDisputeForDeveloper throws NotFoundError for unknown id', () => {
    const { svc } = makeSvc();
    expect(() => svc.getDisputeForDeveloper('ghost', 'u1')).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

describe('POST /api/billing/disputes', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/billing/disputes').send({ usage_event_id: 'e1', reason: 'x' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid body', async () => {
    const res = await request(buildApp())
      .post('/api/billing/disputes')
      .set('x-user-id', 'u1')
      .send({ reason: 'x' }); // missing usage_event_id
    expect(res.status).toBe(400);
  });

  it('opens a dispute and returns 201', async () => {
    const { svc } = makeSvc();
    const res = await request(buildApp(svc))
      .post('/api/billing/disputes')
      .set('x-user-id', 'u1')
      .send({ usage_event_id: 'evt-1', reason: 'wrong charge' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.opened_by).toBe('u1');
  });

  it('returns 409 for duplicate usage_event_id', async () => {
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'evt-1', reason: 'x' }, 'u1');
    const res = await request(buildApp(svc))
      .post('/api/billing/disputes')
      .set('x-user-id', 'u2')
      .send({ usage_event_id: 'evt-1', reason: 'y' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/billing/disputes', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/billing/disputes');
    expect(res.status).toBe(401);
  });

  it('returns only the authenticated user disputes', async () => {
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u2');
    const res = await request(buildApp(svc))
      .get('/api/billing/disputes')
      .set('x-user-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.disputes[0].opened_by).toBe('u1');
  });
});

describe('GET /api/billing/disputes/:id', () => {
  it('returns 401 without auth', async () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc)).get(`/api/billing/disputes/${d.id}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when another user accesses the dispute', async () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc))
      .get(`/api/billing/disputes/${d.id}`)
      .set('x-user-id', 'u2');
    expect(res.status).toBe(403);
  });

  it('returns dispute + events for the owner', async () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc))
      .get(`/api/billing/disputes/${d.id}`)
      .set('x-user-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body.dispute.id).toBe(d.id);
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  it('returns 404 for unknown dispute', async () => {
    const res = await request(buildApp())
      .get('/api/billing/disputes/ghost')
      .set('x-user-id', 'u1');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/billing/disputes/:id/resolve', () => {
  it('returns 401 without admin auth', async () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc))
      .post(`/api/billing/disputes/${d.id}/resolve`)
      .send({ resolution: 'REFUNDED' });
    expect(res.status).toBe(401);
  });

  it('resolves a dispute as admin (REFUNDED)', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc))
      .post(`/api/billing/disputes/${d.id}/resolve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'REFUNDED' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
  });

  it('resolves a dispute as admin (UPHELD)', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc))
      .post(`/api/billing/disputes/${d.id}/resolve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'UPHELD', notes: 'charge was correct' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UPHELD');
  });

  it('returns 400 for invalid resolution value', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    const res = await request(buildApp(svc))
      .post(`/api/billing/disputes/${d.id}/resolve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'CANCELLED' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown dispute', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const res = await request(buildApp())
      .post('/api/billing/disputes/ghost/resolve')
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'UPHELD' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when already resolved', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1') as ReturnType<InMemoryDisputeRepository['create']>;
    svc.resolveDispute(d.id, { resolution: 'UPHELD' }, 'admin');
    const res = await request(buildApp(svc))
      .post(`/api/billing/disputes/${d.id}/resolve`)
      .set('x-admin-api-key', ADMIN_KEY)
      .send({ resolution: 'REFUNDED' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/billing/disputes/admin/all', () => {
  it('returns 401 without admin auth', async () => {
    const res = await request(buildApp()).get('/api/billing/disputes/admin/all');
    expect(res.status).toBe(401);
  });

  it('returns all disputes for admin', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    svc.openDispute({ usage_event_id: 'e2', reason: 'y' }, 'u2');
    const res = await request(buildApp(svc))
      .get('/api/billing/disputes/admin/all')
      .set('x-admin-api-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });
});
