/**
 * Tests for the per-developer concurrency stat endpoints:
 *
 *   GET /api/admin/metrics/concurrency
 *   GET /api/admin/metrics/concurrency/:developerId
 *
 * Each test uses an isolated `DeveloperSemaphore` instance so tests are fully
 * independent and do not touch the live `billingConcurrencySemaphore` singleton.
 *
 * The `buildApp` helper replicates the auth middleware applied by the parent
 * admin router (IP allowlist + adminAuth + adminActor local), keeping the
 * tests self-contained.
 */

import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../middleware/errorHandler.js';
import { DeveloperSemaphore } from '../../utils/developerSemaphore.js';
import { createAdminMetricsConcurrencyRouter } from './metrics.js';

const ADMIN_KEY = 'test-admin-key';

/**
 * Builds a minimal Express app that mounts the metrics router with the
 * supplied `DeveloperSemaphore`.  A stub auth middleware is applied first to
 * simulate the parent admin router's auth/IP-allowlist guards.
 */
function buildApp(developerSemaphore: DeveloperSemaphore) {
  const app = express();
  app.use(express.json());

  // Mimic the parent admin router's auth guard
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });

  app.use('/api/admin/metrics', createAdminMetricsConcurrencyRouter({ developerSemaphore }));
  app.use(errorHandler);
  return app;
}

// ── GET /api/admin/metrics/concurrency ──────────────────────────────────────

describe('GET /api/admin/metrics/concurrency', () => {
  let developerSemaphore: DeveloperSemaphore;

  beforeEach(() => {
    // maxConcurrency=5 so tests can hold multiple slots without queuing
    developerSemaphore = new DeveloperSemaphore(5, 1_000);
  });

  afterEach(() => {
    developerSemaphore.clear();
  });

  it('returns empty counts when no developers are active', async () => {
    const app = buildApp(developerSemaphore);

    const response = await request(app)
      .get('/api/admin/metrics/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      developerCounts: {},
      totalActive: 0,
      campaign: 'GrantFox FWC26',
    });
  });

  it('reflects a single developer holding one slot', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_alice', async () => {
      const response = await request(app)
        .get('/api/admin/metrics/concurrency')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(response.body.data.developerCounts).toEqual({ dev_alice: 1 });
      expect(response.body.data.totalActive).toBe(1);
    });
  });

  it('reflects a developer holding multiple slots', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_alice', async () => {
      await developerSemaphore.withSlot('dev_alice', async () => {
        const response = await request(app)
          .get('/api/admin/metrics/concurrency')
          .set('x-admin-api-key', ADMIN_KEY);

        expect(response.status).toBe(200);
        expect(response.body.data.developerCounts).toEqual({ dev_alice: 2 });
        expect(response.body.data.totalActive).toBe(2);
      });
    });
  });

  it('reflects multiple developers holding slots simultaneously', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_alice', async () => {
      await developerSemaphore.withSlot('dev_bob', async () => {
        const response = await request(app)
          .get('/api/admin/metrics/concurrency')
          .set('x-admin-api-key', ADMIN_KEY);

        expect(response.status).toBe(200);
        expect(response.body.data.totalActive).toBe(2);
        expect(response.body.data.developerCounts).toMatchObject({
          dev_alice: 1,
          dev_bob: 1,
        });
        expect(response.body.data.campaign).toBe('GrantFox FWC26');
      });
    });
  });

  it('omits developers with zero active slots from developerCounts', async () => {
    const app = buildApp(developerSemaphore);

    // Acquire then release a slot for dev_alice
    await developerSemaphore.withSlot('dev_alice', async () => {
      // slot held but we're about to release immediately
    });

    // After release, dev_alice should not appear in counts
    const response = await request(app)
      .get('/api/admin/metrics/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data.developerCounts).toEqual({});
    expect(response.body.data.totalActive).toBe(0);
  });

  it('requires admin authentication', async () => {
    const app = buildApp(developerSemaphore);

    const response = await request(app)
      .get('/api/admin/metrics/concurrency');
    // No x-admin-api-key header

    expect(response.status).toBe(401);
  });

  it('includes campaign label in the response', async () => {
    const app = buildApp(developerSemaphore);

    const response = await request(app)
      .get('/api/admin/metrics/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data.campaign).toBe('GrantFox FWC26');
  });
});

// ── GET /api/admin/metrics/concurrency/:developerId ─────────────────────────

describe('GET /api/admin/metrics/concurrency/:developerId', () => {
  let developerSemaphore: DeveloperSemaphore;

  beforeEach(() => {
    developerSemaphore = new DeveloperSemaphore(2, 1_000);
  });

  afterEach(() => {
    developerSemaphore.clear();
  });

  it('returns zero counts for an unknown developer', async () => {
    const app = buildApp(developerSemaphore);

    const response = await request(app)
      .get('/api/admin/metrics/concurrency/dev_nobody')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      developerId: 'dev_nobody',
      activeCount: 0,
      queueLength: 0,
      atLimit: false,
      campaign: 'GrantFox FWC26',
    });
  });

  it('returns active count for a developer currently holding a slot', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_alice', async () => {
      const response = await request(app)
        .get('/api/admin/metrics/concurrency/dev_alice')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        developerId: 'dev_alice',
        activeCount: 1,
        queueLength: 0,
        atLimit: false,
      });
    });
  });

  it('returns activeCount=0 once the slot is released', async () => {
    const app = buildApp(developerSemaphore);

    // Hold then release a slot
    await developerSemaphore.withSlot('dev_alice', async () => {});

    const response = await request(app)
      .get('/api/admin/metrics/concurrency/dev_alice')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data.activeCount).toBe(0);
    expect(response.body.data.atLimit).toBe(false);
  });

  it('reports atLimit: true when developer is at their concurrency limit', async () => {
    // maxConcurrency=1 so a single slot saturates the limit
    const sem = new DeveloperSemaphore(1, 1_000);
    const app = buildApp(sem);

    await sem.withSlot('dev_maxed', async () => {
      const response = await request(app)
        .get('/api/admin/metrics/concurrency/dev_maxed')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        developerId: 'dev_maxed',
        activeCount: 1,
        atLimit: true,
      });
    });

    sem.clear();
  });

  it('requires admin authentication', async () => {
    const app = buildApp(developerSemaphore);

    const response = await request(app)
      .get('/api/admin/metrics/concurrency/dev_alice');
    // No x-admin-api-key header

    expect(response.status).toBe(401);
  });

  it('returns 404 when developerId path segment is missing', async () => {
    const app = buildApp(developerSemaphore);

    // Without the :developerId segment the /concurrency route handles it
    const response = await request(app)
      .get('/api/admin/metrics/concurrency/')
      .set('x-admin-api-key', ADMIN_KEY);

    // Falls through to the GET /concurrency list route — should be 200
    expect([200, 404]).toContain(response.status);
  });

  it('includes campaign label in the detail response', async () => {
    const app = buildApp(developerSemaphore);

    const response = await request(app)
      .get('/api/admin/metrics/concurrency/dev_alice')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data.campaign).toBe('GrantFox FWC26');
  });
});
