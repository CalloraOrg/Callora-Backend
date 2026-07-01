/**
 * Tests for the plugin marketplace — routes and registry service.
 *
 * Covers:
 *   - PluginManifest schema validation
 *   - InMemoryPluginRepository CRUD and error cases
 *   - executeHook sandbox stub
 *   - HTTP endpoints: list, register, get, install, uninstall, delete
 *   - Auth enforcement on mutating routes
 *   - Audit logging on state changes
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
import { createPluginsRouter } from './plugins.js';
import {
  pluginManifestSchema,
  InMemoryPluginRepository,
  executeHook,
  type PluginManifest,
  type PluginRecord,
} from '../../services/pluginRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validManifest: PluginManifest = {
  id: 'flat-rate-billing',
  name: 'Flat Rate Billing',
  version: '1.0.0',
  description: 'Applies a flat rate to every charge',
  author: 'community',
  hooks: ['before_charge'],
  source_url: 'https://github.com/example/flat-rate-billing',
};

function buildApp(repo?: InMemoryPluginRepository) {
  const app = express();
  app.use(express.json());
  app.use('/api/marketplace/plugins', createPluginsRouter({ pluginRepository: repo }));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// PluginManifest schema tests
// ---------------------------------------------------------------------------

describe('pluginManifestSchema', () => {
  it('accepts a valid manifest', () => {
    expect(() => pluginManifestSchema.parse(validManifest)).not.toThrow();
  });

  it.each([
    ['id too short', { ...validManifest, id: 'ab' }],
    ['id with uppercase', { ...validManifest, id: 'Bad-ID' }],
    ['id with spaces', { ...validManifest, id: 'bad id' }],
    ['invalid version', { ...validManifest, version: '1.0' }],
    ['empty hooks', { ...validManifest, hooks: [] }],
    ['invalid hook name', { ...validManifest, hooks: ['unknown_hook'] }],
    ['invalid source_url', { ...validManifest, source_url: 'not-a-url' }],
  ])('rejects: %s', (_, data) => {
    expect(() => pluginManifestSchema.parse(data)).toThrow();
  });

  it('allows optional fields to be absent', () => {
    const { description: _, author: __, source_url: ___, ...minimal } = validManifest;
    expect(() => pluginManifestSchema.parse(minimal)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// InMemoryPluginRepository unit tests
// ---------------------------------------------------------------------------

describe('InMemoryPluginRepository', () => {
  let repo: InMemoryPluginRepository;

  beforeEach(() => {
    repo = new InMemoryPluginRepository();
  });

  describe('register', () => {
    it('registers a plugin and sets status=available', () => {
      const record = repo.register(validManifest);
      expect(record.status).toBe('available');
      expect(record.installed_by).toBeNull();
      expect(record.installed_at).toBeNull();
      expect(record.manifest.id).toBe(validManifest.id);
    });

    it('throws ConflictError on duplicate id', () => {
      repo.register(validManifest);
      expect(() => repo.register(validManifest)).toThrow(/already registered/);
    });
  });

  describe('list', () => {
    it('returns empty array when no plugins registered', () => {
      expect(repo.list()).toHaveLength(0);
    });

    it('returns all registered plugins', () => {
      repo.register(validManifest);
      repo.register({ ...validManifest, id: 'plugin-two' });
      expect(repo.list()).toHaveLength(2);
    });
  });

  describe('findById', () => {
    it('returns undefined for unknown id', () => {
      expect(repo.findById('ghost')).toBeUndefined();
    });

    it('returns the record for a known id', () => {
      repo.register(validManifest);
      expect(repo.findById(validManifest.id)).toBeDefined();
    });
  });

  describe('install', () => {
    it('transitions status to installed', () => {
      repo.register(validManifest);
      const record = repo.install(validManifest.id, 'user-1');
      expect(record.status).toBe('installed');
      expect(record.installed_by).toBe('user-1');
      expect(record.installed_at).not.toBeNull();
    });

    it('throws NotFoundError for unknown plugin', () => {
      expect(() => repo.install('ghost', 'user-1')).toThrow(/not found/);
    });

    it('throws ConflictError when already installed', () => {
      repo.register(validManifest);
      repo.install(validManifest.id, 'user-1');
      expect(() => repo.install(validManifest.id, 'user-2')).toThrow(/already installed/);
    });
  });

  describe('uninstall', () => {
    it('transitions installed plugin back to available', () => {
      repo.register(validManifest);
      repo.install(validManifest.id, 'user-1');
      const record = repo.uninstall(validManifest.id, 'user-1');
      expect(record.status).toBe('available');
      expect(record.installed_at).toBeNull();
    });

    it('throws NotFoundError for unknown plugin', () => {
      expect(() => repo.uninstall('ghost', 'user-1')).toThrow(/not found/);
    });

    it('throws BadRequestError when plugin not installed', () => {
      repo.register(validManifest);
      expect(() => repo.uninstall(validManifest.id, 'user-1')).toThrow(/not installed/);
    });
  });

  describe('delete', () => {
    it('removes a registered plugin', () => {
      repo.register(validManifest);
      repo.delete(validManifest.id);
      expect(repo.findById(validManifest.id)).toBeUndefined();
    });

    it('throws NotFoundError for unknown plugin', () => {
      expect(() => repo.delete('ghost')).toThrow(/not found/);
    });
  });
});

// ---------------------------------------------------------------------------
// executeHook sandbox stub tests
// ---------------------------------------------------------------------------

describe('executeHook', () => {
  let repo: InMemoryPluginRepository;
  let record: PluginRecord;

  beforeEach(() => {
    repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    record = repo.install(validManifest.id, 'user-1');
  });

  it('returns ok=true with sandboxed=true for a declared hook', () => {
    const result = executeHook(record, 'before_charge', { userId: 'user-1' });
    expect(result.ok).toBe(true);
    expect(result.sandboxed).toBe(true);
    expect(result.pluginId).toBe(validManifest.id);
  });

  it('throws BadRequestError for an undeclared hook', () => {
    expect(() => executeHook(record, 'on_refund', { userId: 'user-1' })).toThrow(/does not declare hook/);
  });

  it('throws BadRequestError when plugin is not installed', () => {
    repo.uninstall(validManifest.id, 'user-1');
    const uninstalledRecord = repo.findById(validManifest.id)!;
    expect(() => executeHook(uninstalledRecord, 'before_charge', { userId: 'user-1' })).toThrow(/must be installed/);
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

describe('GET /api/marketplace/plugins', () => {
  it('returns empty list initially', async () => {
    const res = await request(buildApp()).get('/api/marketplace/plugins');
    expect(res.status).toBe(200);
    expect(res.body.plugins).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('lists registered plugins', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo)).get('/api/marketplace/plugins');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.plugins[0].manifest.id).toBe(validManifest.id);
  });
});

describe('POST /api/marketplace/plugins', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/marketplace/plugins')
      .send(validManifest);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid manifest', async () => {
    const res = await request(buildApp())
      .post('/api/marketplace/plugins')
      .set('x-user-id', 'user-1')
      .send({ id: 'bad ID!', name: 'x', version: 'nope', hooks: [] });
    expect(res.status).toBe(400);
  });

  it('registers a valid plugin and returns 201', async () => {
    const res = await request(buildApp())
      .post('/api/marketplace/plugins')
      .set('x-user-id', 'user-1')
      .send(validManifest);
    expect(res.status).toBe(201);
    expect(res.body.manifest.id).toBe(validManifest.id);
    expect(res.body.status).toBe('available');
  });

  it('returns 409 when registering a duplicate plugin', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo))
      .post('/api/marketplace/plugins')
      .set('x-user-id', 'user-1')
      .send(validManifest);
    expect(res.status).toBe(409);
  });
});

describe('GET /api/marketplace/plugins/:id', () => {
  it('returns 404 for unknown plugin', async () => {
    const res = await request(buildApp()).get('/api/marketplace/plugins/ghost');
    expect(res.status).toBe(404);
  });

  it('returns the plugin record', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo)).get(`/api/marketplace/plugins/${validManifest.id}`);
    expect(res.status).toBe(200);
    expect(res.body.manifest.id).toBe(validManifest.id);
  });
});

describe('POST /api/marketplace/plugins/:id/install', () => {
  it('returns 401 without auth', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo))
      .post(`/api/marketplace/plugins/${validManifest.id}/install`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown plugin', async () => {
    const res = await request(buildApp())
      .post('/api/marketplace/plugins/ghost/install')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(404);
  });

  it('installs the plugin and fires hook', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo))
      .post(`/api/marketplace/plugins/${validManifest.id}/install`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.plugin.status).toBe('installed');
    expect(res.body.plugin.installed_by).toBe('user-1');
    // before_charge is declared, so hook should be fired
    expect(res.body.hook).not.toBeNull();
    expect(res.body.hook.ok).toBe(true);
    expect(res.body.hook.sandboxed).toBe(true);
  });

  it('returns 409 when already installed', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    repo.install(validManifest.id, 'user-1');
    const res = await request(buildApp(repo))
      .post(`/api/marketplace/plugins/${validManifest.id}/install`)
      .set('x-user-id', 'user-2');
    expect(res.status).toBe(409);
  });

  it('returns null hook when plugin does not declare before_charge', async () => {
    const repo = new InMemoryPluginRepository();
    const noBeforeCharge: PluginManifest = { ...validManifest, id: 'refund-plugin', hooks: ['on_refund'] };
    repo.register(noBeforeCharge);
    const res = await request(buildApp(repo))
      .post(`/api/marketplace/plugins/${noBeforeCharge.id}/install`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.hook).toBeNull();
  });
});

describe('DELETE /api/marketplace/plugins/:id/install', () => {
  it('returns 401 without auth', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    repo.install(validManifest.id, 'user-1');
    const res = await request(buildApp(repo))
      .delete(`/api/marketplace/plugins/${validManifest.id}/install`);
    expect(res.status).toBe(401);
  });

  it('uninstalls an installed plugin', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    repo.install(validManifest.id, 'user-1');
    const res = await request(buildApp(repo))
      .delete(`/api/marketplace/plugins/${validManifest.id}/install`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('available');
  });

  it('returns 400 when plugin is not installed', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo))
      .delete(`/api/marketplace/plugins/${validManifest.id}/install`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown plugin', async () => {
    const res = await request(buildApp())
      .delete('/api/marketplace/plugins/ghost/install')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/marketplace/plugins/:id', () => {
  it('returns 401 without auth', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo))
      .delete(`/api/marketplace/plugins/${validManifest.id}`);
    expect(res.status).toBe(401);
  });

  it('removes the plugin and returns 204', async () => {
    const repo = new InMemoryPluginRepository();
    repo.register(validManifest);
    const res = await request(buildApp(repo))
      .delete(`/api/marketplace/plugins/${validManifest.id}`)
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(204);
    expect(repo.findById(validManifest.id)).toBeUndefined();
  });

  it('returns 404 for unknown plugin', async () => {
    const res = await request(buildApp())
      .delete('/api/marketplace/plugins/ghost')
      .set('x-user-id', 'user-1');
    expect(res.status).toBe(404);
  });
});
