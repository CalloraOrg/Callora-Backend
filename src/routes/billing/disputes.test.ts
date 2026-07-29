/**
 * Tests for dispute-resolution flow (#463).
 *
 * Covers:
 *   - openDisputeSchema / resolveDisputeSchema validation
 *   - InMemoryDisputeRepository state machine + audit trail
 *   - DisputeService RBAC helpers
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

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createDisputesRouter } from './disputes.js';
import {
  openDisputeSchema,
  resolveDisputeSchema,
  InMemoryDisputeRepository,
  DisputeService,
} from '../../services/disputeService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-admin-key';

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
// DisputeService
// ---------------------------------------------------------------------------

describe('DisputeService', () => {
  it('openDispute creates dispute and appends OPENED event', () => {
    const { svc, repo } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    expect(d.status).toBe('OPEN');
    expect(repo.getEvents(d.id).some(e => e.action === 'OPENED')).toBe(true);
  });

  it('resolveDispute updates status and appends RESOLVED event', () => {
    const { svc, repo } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    const resolved = svc.resolveDispute(d.id, { resolution: 'REFUNDED' }, 'admin');
    expect(resolved.status).toBe('REFUNDED');
    expect(repo.getEvents(d.id).some(e => e.action === 'RESOLVED')).toBe(true);
  });

  it('getDisputeForDeveloper throws ForbiddenError for wrong user', () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
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
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    const res = await request(buildApp(svc)).get(`/api/billing/disputes/${d.id}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when another user accesses the dispute', async () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    const res = await request(buildApp(svc))
      .get(`/api/billing/disputes/${d.id}`)
      .set('x-user-id', 'u2');
    expect(res.status).toBe(403);
  });

  it('returns dispute + events for the owner', async () => {
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
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
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
    const res = await request(buildApp(svc))
      .post(`/api/billing/disputes/${d.id}/resolve`)
      .send({ resolution: 'REFUNDED' });
    expect(res.status).toBe(401);
  });

  it('resolves a dispute as admin (REFUNDED)', async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { svc } = makeSvc();
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
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
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
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
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
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
    const d = svc.openDispute({ usage_event_id: 'e1', reason: 'x' }, 'u1');
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
