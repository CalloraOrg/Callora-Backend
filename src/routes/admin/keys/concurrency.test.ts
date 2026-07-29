import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../../middleware/errorHandler.js';
import { KeySemaphore } from '../../../utils/keySemaphore.js';
import { createAdminKeyConcurrencyRouter } from './concurrency.js';

const ADMIN_KEY = 'test-admin-key';

function buildApp(keySemaphore: KeySemaphore) {
  const app = express();
  app.use(express.json());
  // Mimic the parent admin router's auth/IP-allowlist middleware
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });
  app.use('/api/admin/keys', createAdminKeyConcurrencyRouter({ keySemaphore }));
  app.use(errorHandler);
  return app;
}

describe('GET /api/admin/keys/concurrency', () => {
  let keySemaphore: KeySemaphore;

  beforeEach(() => {
    keySemaphore = new KeySemaphore(5, 1000);
  });

  afterEach(() => {
    keySemaphore.clear();
  });

  it('returns empty counts when no keys are active', async () => {
    const app = buildApp(keySemaphore);

    const response = await request(app)
      .get('/api/admin/keys/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      keyCounts: {},
      totalActive: 0,
      campaign: 'GrantFox FWC26',
    });
  });

  it('returns active slot counts for all keys', async () => {
    const app = buildApp(keySemaphore);

    // Acquire some slots
    await keySemaphore.withSlot('key_abc', async () => {
      await keySemaphore.withSlot('key_abc', async () => {
        const response = await request(app)
          .get('/api/admin/keys/concurrency')
          .set('x-admin-api-key', ADMIN_KEY);

        expect(response.status).toBe(200);
        expect(response.body.data.keyCounts).toEqual({
          key_abc: 2,
        });
        expect(response.body.data.totalActive).toBe(2);
        expect(response.body.data.campaign).toBe('GrantFox FWC26');
      });
    });
  });

  it('returns counts for multiple different keys', async () => {
    const sem = keySemaphore; // shorter alias
    const app = buildApp(sem);

    // Hold slots on two different keys and read stats
    await sem.withSlot('key_abc', async () => {
      await sem.withSlot('key_def', async () => {
        const response = await request(app)
          .get('/api/admin/keys/concurrency')
          .set('x-admin-api-key', ADMIN_KEY);

        expect(response.status).toBe(200);
        expect(response.body.data.totalActive).toBe(2);
        expect(response.body.data.keyCounts).toMatchObject({
          key_abc: 1,
          key_def: 1,
        });
      });
    });
  });

  it('requires admin authentication', async () => {
    const app = buildApp(keySemaphore);

    const response = await request(app)
      .get('/api/admin/keys/concurrency');

    expect(response.status).toBe(401);
  });
});

describe('GET /api/admin/keys/concurrency/:keyId', () => {
  let keySemaphore: KeySemaphore;

  beforeEach(() => {
    keySemaphore = new KeySemaphore(5, 1000);
  });

  afterEach(() => {
    keySemaphore.clear();
  });

  it('returns zero active count for an idle key', async () => {
    const app = buildApp(keySemaphore);

    const response = await request(app)
      .get('/api/admin/keys/concurrency/key_idle')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      keyId: 'key_idle',
      activeCount: 0,
      atLimit: false,
      campaign: 'GrantFox FWC26',
    });
  });

  it('returns active count for a key holding slots', async () => {
    const app = buildApp(keySemaphore);

    await keySemaphore.withSlot('key_busy', async () => {
      const response = await request(app)
        .get('/api/admin/keys/concurrency/key_busy')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        keyId: 'key_busy',
        activeCount: 1,
        atLimit: false,
      });
    });

    // After release, count should be zero
    const response2 = await request(app)
      .get('/api/admin/keys/concurrency/key_busy')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response2.body.data.activeCount).toBe(0);
    expect(response2.body.data.atLimit).toBe(false);
  });

  it('reports atLimit: true when key is at its concurrency limit', async () => {
    // Use maxConcurrency=1 so a single slot reaches the limit
    const sem = new KeySemaphore(1, 1000);
    const app = buildApp(sem);

    await sem.withSlot('key_maxed', async () => {
      const response = await request(app)
        .get('/api/admin/keys/concurrency/key_maxed')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        keyId: 'key_maxed',
        activeCount: 1,
        atLimit: true,
      });
    });
  });

  it('requires admin authentication', async () => {
    const app = buildApp(keySemaphore);

    const response = await request(app)
      .get('/api/admin/keys/concurrency/key_abc');

    expect(response.status).toBe(401);
  });

  it('treats a trailing slash as the collection endpoint, not an empty keyId', async () => {
    const app = buildApp(keySemaphore);

    // Express (with strict routing off) normalises the trailing slash, so this
    // matches GET /concurrency rather than /concurrency/:keyId with an empty
    // param. The detail handler is therefore never reached with a blank keyId.
    const response = await request(app)
      .get('/api/admin/keys/concurrency/')
      .set('x-admin-api-key', ADMIN_KEY);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('keyCounts');
    expect(response.body.data).not.toHaveProperty('keyId');
  });

  it('reports the configured per-key ceiling alongside the counts', async () => {
    const sem = new KeySemaphore(9, 1000);
    const app = buildApp(sem);

    const listResponse = await request(app)
      .get('/api/admin/keys/concurrency')
      .set('x-admin-api-key', ADMIN_KEY);
    expect(listResponse.body.data.maxConcurrencyPerKey).toBe(9);

    const detailResponse = await request(app)
      .get('/api/admin/keys/concurrency/key_abc')
      .set('x-admin-api-key', ADMIN_KEY);
    expect(detailResponse.body.data.maxConcurrencyPerKey).toBe(9);
  });
});
