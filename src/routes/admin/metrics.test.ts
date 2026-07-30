/**
 * Tests for src/routes/admin/metrics.ts
 *
 * GrantFox FWC26 — per-developer billing-concurrency stats
 *
 * These tests use an injected DeveloperSemaphore so they are fully isolated
 * from the sharedDeveloperSemaphore singleton and from each other.
 */
import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../middleware/errorHandler.js';
import { DeveloperSemaphore } from '../../utils/developerSemaphore.js';
import { createAdminDevMetricsRouter } from './metrics.js';

const ADMIN_KEY = 'test-admin-key';

/** Minimal Express app that wraps the router with stub admin auth. */
function buildApp(developerSemaphore: DeveloperSemaphore) {
  const app = express();
  app.use(express.json());

  // Mimic the parent admin router's auth middleware
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });

  app.use('/api/admin/metrics', createAdminDevMetricsRouter({ developerSemaphore }));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/admin/metrics — per-developer concurrency stats overview
// ---------------------------------------------------------------------------

describe('GET /api/admin/metrics', () => {
  let developerSemaphore: DeveloperSemaphore;

  beforeEach(() => {
    developerSemaphore = new DeveloperSemaphore(5, 1000);
  });

  afterEach(() => {
    developerSemaphore.clear();
  });

  it('returns empty stats when no developers are active', async () => {
    const app = buildApp(developerSemaphore);

    const res = await request(app)
      .get('/api/admin/metrics')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalActive: 0,
      activeDeveloperCount: 0,
      perDeveloper: [],
      campaign: 'GrantFox FWC26',
    });
    expect(res.body.data.maxConcurrencyPerDeveloper).toBe(5);
  });

  it('returns per-developer stats with correct utilization', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_abc', async () => {
      await developerSemaphore.withSlot('dev_abc', async () => {
        await developerSemaphore.withSlot('dev_def', async () => {
          const res = await request(app)
            .get('/api/admin/metrics')
            .set('x-admin-api-key', ADMIN_KEY);

          expect(res.status).toBe(200);
          expect(res.body.data.totalActive).toBe(3);
          expect(res.body.data.activeDeveloperCount).toBe(2);
          expect(res.body.data.perDeveloper).toHaveLength(2);
          expect(res.body.data.perDeveloper[0]).toMatchObject({
            developerId: 'dev_abc',
            activeCount: 2,
            atLimit: false,
            utilizationPercent: 40,
          });
          expect(res.body.data.perDeveloper[1]).toMatchObject({
            developerId: 'dev_def',
            activeCount: 1,
            atLimit: false,
            utilizationPercent: 20,
          });
        });
      });
    });
  });

  it('reports atLimit and 100% utilization when exactly at the ceiling', async () => {
    const sem = new DeveloperSemaphore(1, 1000);
    const app = buildApp(sem);

    await sem.withSlot('dev_maxed', async () => {
      const res = await request(app)
        .get('/api/admin/metrics')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.perDeveloper[0]).toMatchObject({
        developerId: 'dev_maxed',
        activeCount: 1,
        atLimit: true,
        utilizationPercent: 100,
      });
    });
    sem.clear();
  });

  it('sorts per-developer results by active count descending', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_light', async () => {
      await developerSemaphore.withSlot('dev_heavy', async () => {
        await developerSemaphore.withSlot('dev_heavy', async () => {
          await developerSemaphore.withSlot('dev_heavy', async () => {
            const res = await request(app)
              .get('/api/admin/metrics')
              .set('x-admin-api-key', ADMIN_KEY);

            expect(res.status).toBe(200);
            expect(res.body.data.perDeveloper[0].developerId).toBe('dev_heavy');
            expect(res.body.data.perDeveloper[0].activeCount).toBe(3);
            expect(res.body.data.perDeveloper[1].developerId).toBe('dev_light');
            expect(res.body.data.perDeveloper[1].activeCount).toBe(1);
          });
        });
      });
    });
  });

  it('requires admin authentication — 401 without credentials', async () => {
    const app = buildApp(developerSemaphore);

    const res = await request(app).get('/api/admin/metrics');

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/metrics/concurrency — collection endpoint
// ---------------------------------------------------------------------------

describe('GET /api/admin/metrics/concurrency', () => {
  let developerSemaphore: DeveloperSemaphore;

  beforeEach(() => {
    developerSemaphore = new DeveloperSemaphore(5, 1000);
  });

  afterEach(() => {
    developerSemaphore.clear();
  });

  it('returns empty counts when no developers are active', async () => {
    const app = buildApp(developerSemaphore);

    const res = await request(app)
      .get('/api/admin/metrics/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      devCounts: {},
      totalActive: 0,
      campaign: 'GrantFox FWC26',
    });
  });

  it('returns active slot counts for a single developer', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_abc', async () => {
      await developerSemaphore.withSlot('dev_abc', async () => {
        const res = await request(app)
          .get('/api/admin/metrics/concurrency')
          .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        expect(res.body.data.devCounts).toEqual({ dev_abc: 2 });
        expect(res.body.data.totalActive).toBe(2);
        expect(res.body.data.campaign).toBe('GrantFox FWC26');
      });
    });
  });

  it('returns counts for multiple different developers', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_abc', async () => {
      await developerSemaphore.withSlot('dev_def', async () => {
        const res = await request(app)
          .get('/api/admin/metrics/concurrency')
          .set('x-admin-api-key', ADMIN_KEY);

        expect(res.status).toBe(200);
        expect(res.body.data.totalActive).toBe(2);
        expect(res.body.data.devCounts).toMatchObject({
          dev_abc: 1,
          dev_def: 1,
        });
      });
    });
  });

  it('counts drop back to zero once all slots are released', async () => {
    const app = buildApp(developerSemaphore);

    // Acquire and release
    await developerSemaphore.withSlot('dev_abc', async () => {});

    const res = await request(app)
      .get('/api/admin/metrics/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.devCounts).toEqual({});
    expect(res.body.data.totalActive).toBe(0);
  });

  it('reports the configured per-developer ceiling', async () => {
    const sem = new DeveloperSemaphore(9, 1000);
    const app = buildApp(sem);

    const res = await request(app)
      .get('/api/admin/metrics/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.maxConcurrencyPerDeveloper).toBe(9);
    sem.clear();
  });

  it('requires admin authentication — 401 without credentials', async () => {
    const app = buildApp(developerSemaphore);

    const res = await request(app)
      .get('/api/admin/metrics/concurrency');

    expect(res.status).toBe(401);
  });

  it('returns only developers with active slots (omits zero-slot entries)', async () => {
    const app = buildApp(developerSemaphore);

    // dev_idle has been active before but its slots are already released
    await developerSemaphore.withSlot('dev_idle', async () => {});
    await developerSemaphore.withSlot('dev_busy', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/concurrency')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      // dev_idle should NOT appear
      expect(res.body.data.devCounts).not.toHaveProperty('dev_idle');
      expect(res.body.data.devCounts).toHaveProperty('dev_busy', 1);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/metrics/concurrency/:developerId — detail endpoint
// ---------------------------------------------------------------------------

describe('GET /api/admin/metrics/concurrency/:developerId', () => {
  let developerSemaphore: DeveloperSemaphore;

  beforeEach(() => {
    developerSemaphore = new DeveloperSemaphore(5, 1000);
  });

  afterEach(() => {
    developerSemaphore.clear();
  });

  it('returns zero active count for a developer with no active slots', async () => {
    const app = buildApp(developerSemaphore);

    const res = await request(app)
      .get('/api/admin/metrics/concurrency/dev_idle')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      developerId: 'dev_idle',
      activeCount: 0,
      atLimit: false,
      campaign: 'GrantFox FWC26',
    });
  });

  it('returns active count for a developer currently holding a slot', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_busy', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/concurrency/dev_busy')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        developerId: 'dev_busy',
        activeCount: 1,
        atLimit: false,
      });
    });
  });

  it('active count drops to zero after slot is released', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev_release', async () => {});

    const res = await request(app)
      .get('/api/admin/metrics/concurrency/dev_release')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.activeCount).toBe(0);
    expect(res.body.data.atLimit).toBe(false);
  });

  it('reports atLimit: true when developer is at their concurrency ceiling', async () => {
    // Use maxConcurrency=1 so a single slot saturates the developer
    const sem = new DeveloperSemaphore(1, 1000);
    const app = buildApp(sem);

    await sem.withSlot('dev_maxed', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/concurrency/dev_maxed')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        developerId: 'dev_maxed',
        activeCount: 1,
        atLimit: true,
      });
    });
    sem.clear();
  });

  it('reports atLimit: false when developer is below their concurrency ceiling', async () => {
    const sem = new DeveloperSemaphore(3, 1000);
    const app = buildApp(sem);

    await sem.withSlot('dev_partial', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/concurrency/dev_partial')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.atLimit).toBe(false);
      expect(res.body.data.activeCount).toBe(1);
    });
    sem.clear();
  });

  it('reports the configured per-developer ceiling in the detail response', async () => {
    const sem = new DeveloperSemaphore(9, 1000);
    const app = buildApp(sem);

    const res = await request(app)
      .get('/api/admin/metrics/concurrency/any_dev')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.maxConcurrencyPerDeveloper).toBe(9);
    sem.clear();
  });

  it('requires admin authentication — 401 without credentials', async () => {
    const app = buildApp(developerSemaphore);

    const res = await request(app)
      .get('/api/admin/metrics/concurrency/dev_abc');

    expect(res.status).toBe(401);
  });

  it('rejects an empty developerId with 400', async () => {
    // Express router normalises /concurrency/ to /concurrency (collection)
    // so we use a URL-encoded empty string to exercise the validation path.
    const app = buildApp(developerSemaphore);

    // A trailing slash on the collection URL is normalised by Express to match
    // GET /concurrency rather than GET /concurrency/:developerId with an empty
    // param, so it returns 200 with the keyCounts shape.
    const res = await request(app)
      .get('/api/admin/metrics/concurrency/')
      .set('x-admin-api-key', ADMIN_KEY);

    // Express (strict routing off) normalises trailing slash → collection route
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('devCounts');
    expect(res.body.data).not.toHaveProperty('developerId');
  });

  it('handles developer IDs that contain URL-safe characters', async () => {
    const app = buildApp(developerSemaphore);

    await developerSemaphore.withSlot('dev-with-dashes', async () => {
      const res = await request(app)
        .get('/api/admin/metrics/concurrency/dev-with-dashes')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data.developerId).toBe('dev-with-dashes');
      expect(res.body.data.activeCount).toBe(1);
    });
  });

  it('correctly reflects multiple active slots for the same developer', async () => {
    const sem = new DeveloperSemaphore(10, 1000);
    const app = buildApp(sem);

    await sem.withSlot('dev_multi', async () => {
      await sem.withSlot('dev_multi', async () => {
        await sem.withSlot('dev_multi', async () => {
          const res = await request(app)
            .get('/api/admin/metrics/concurrency/dev_multi')
            .set('x-admin-api-key', ADMIN_KEY);

          expect(res.status).toBe(200);
          expect(res.body.data.activeCount).toBe(3);
          expect(res.body.data.atLimit).toBe(false);
        });
      });
    });
    sem.clear();
  });
});

// ---------------------------------------------------------------------------
// DeveloperSemaphore helper methods (unit coverage for getActiveSlotCount,
// isAtLimit, maxConcurrency getter added in this task)
// ---------------------------------------------------------------------------

describe('DeveloperSemaphore — new helper methods', () => {
  it('getActiveSlotCount returns 0 for an unknown developer', () => {
    const sem = new DeveloperSemaphore(3, 1000);
    expect(sem.getActiveSlotCount('nobody')).toBe(0);
    sem.clear();
  });

  it('getActiveSlotCount returns the correct live count', async () => {
    const sem = new DeveloperSemaphore(3, 1000);

    await sem.withSlot('dev', async () => {
      expect(sem.getActiveSlotCount('dev')).toBe(1);
    });
    sem.clear();
  });

  it('isAtLimit returns false when below the ceiling', async () => {
    const sem = new DeveloperSemaphore(3, 1000);

    await sem.withSlot('dev', async () => {
      expect(sem.isAtLimit('dev')).toBe(false);
    });
    sem.clear();
  });

  it('isAtLimit returns true when exactly at the ceiling', async () => {
    const sem = new DeveloperSemaphore(1, 1000);

    await sem.withSlot('dev', async () => {
      expect(sem.isAtLimit('dev')).toBe(true);
    });
    sem.clear();
  });

  it('isAtLimit returns false for an unknown developer (0 < limit)', () => {
    const sem = new DeveloperSemaphore(1, 1000);
    // 0 active < 1 limit → not at limit
    expect(sem.isAtLimit('nobody')).toBe(false);
    sem.clear();
  });

  it('maxConcurrency getter reflects the constructor argument', () => {
    const sem = new DeveloperSemaphore(7, 1000);
    expect(sem.maxConcurrency).toBe(7);
    sem.clear();
  });
});
