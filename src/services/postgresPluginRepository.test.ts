/**
 * src/services/postgresPluginRepository.test.ts
 *
 * Tests for PostgresPluginRepository backed by pg-mem.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newDb } from 'pg-mem';
import {
  PostgresPluginRepository,
  type PluginRepositoryQueryable,
} from './postgresPluginRepository.js';
import type { PluginManifest } from './pluginRegistry.js';

const MIGRATION_SQL = readFileSync(
  resolve(process.cwd(), 'migrations/0033_marketplace_plugins.sql'),
  'utf8',
);

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    hooks: ['before_charge'],
    ...overrides,
  };
}

function createTestDb() {
  const db = newDb();
  db.public.none(MIGRATION_SQL);
  const { Pool: PgPool } = db.adapters.createPg();
  const pool = new PgPool();
  return {
    pool,
    repo: new PostgresPluginRepository(pool as unknown as PluginRepositoryQueryable),
  };
}

async function assertRejectsName(
  fn: () => Promise<unknown>,
  errorName: string,
  msgFragment?: string,
): Promise<void> {
  let threw = false;
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert.ok(threw, `Expected promise to reject with ${errorName}, but it resolved`);
  const err = caught as Error;
  assert.equal(
    err.name,
    errorName,
    `Expected error.name to be "${errorName}", got "${err.name}"`,
  );
  if (msgFragment) {
    assert.ok(
      err.message.includes(msgFragment),
      `Expected error.message to include "${msgFragment}", got: "${err.message}"`,
    );
  }
}

describe('PostgresPluginRepository', () => {
  test('registers, lists, finds, and survives repository re-instantiation (restart)', async () => {
    const { pool, repo } = createTestDb();
    try {
      const fullManifest: PluginManifest = {
        id: 'full-manifest-plugin',
        name: 'Full Manifest Plugin',
        version: '2.1.0',
        description: 'Round-trip JSONB test',
        author: 'Callora Team',
        hooks: ['before_charge', 'after_charge', 'on_refund', 'on_quota_exceeded'],
        source_url: 'https://github.com/CalloraOrg/example-plugin',
      };

      const registered = await repo.register(fullManifest, 'owner-1');
      assert.deepEqual(registered.manifest, fullManifest);
      assert.equal(registered.owner_id, 'owner-1');
      assert.equal(registered.status, 'available');
      assert.equal(registered.installed_by, null);
      assert.equal(registered.installed_at, null);
      assert.ok(!isNaN(Date.parse(registered.created_at)));

      const installed = await repo.install('full-manifest-plugin', 'user-2');
      assert.equal(installed.status, 'installed');
      assert.equal(installed.installed_by, 'user-2');
      assert.ok(installed.installed_at);

      // Simulate app restart with a fresh repository instance on the same DB
      const repoAfterRestart = new PostgresPluginRepository(
        pool as unknown as PluginRepositoryQueryable,
      );
      const found = await repoAfterRestart.findById('full-manifest-plugin');
      assert.ok(found);
      assert.deepEqual(found.manifest, fullManifest);
      assert.equal(found.status, 'installed');
      assert.equal(found.installed_by, 'user-2');

      const all = await repoAfterRestart.list();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.manifest.id, 'full-manifest-plugin');
    } finally {
      await pool.end();
    }
  });

  test('findById returns undefined for unknown id', async () => {
    const { pool, repo } = createTestDb();
    try {
      const found = await repo.findById('does-not-exist');
      assert.equal(found, undefined);
    } finally {
      await pool.end();
    }
  });

  test('duplicate registration throws ConflictError', async () => {
    const { pool, repo } = createTestDb();
    try {
      await repo.register(makeManifest({ id: 'dup-plugin' }), 'owner-1');
      await assertRejectsName(
        () => repo.register(makeManifest({ id: 'dup-plugin' }), 'owner-2'),
        'ConflictError',
        'dup-plugin',
      );
    } finally {
      await pool.end();
    }
  });

  test('concurrent register of the same id succeeds once and rejects duplicates with ConflictError', async () => {
    const { pool, repo } = createTestDb();
    try {
      const results = await Promise.allSettled([
        repo.register(makeManifest({ id: 'race-plugin' }), 'owner-1'),
        repo.register(makeManifest({ id: 'race-plugin' }), 'owner-2'),
        repo.register(makeManifest({ id: 'race-plugin' }), 'owner-3'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 2);
      for (const r of rejected) {
        assert.equal((r.reason as Error).name, 'ConflictError');
      }
    } finally {
      await pool.end();
    }
  });

  test('install transitions status and rejects unknown (404) or already installed (409)', async () => {
    const { pool, repo } = createTestDb();
    try {
      await assertRejectsName(
        () => repo.install('missing', 'user-1'),
        'NotFoundError',
        'missing',
      );

      await repo.register(makeManifest({ id: 'inst-plugin' }), 'owner-1');
      const installed = await repo.install('inst-plugin', 'user-1');
      assert.equal(installed.status, 'installed');
      assert.equal(installed.installed_by, 'user-1');

      await assertRejectsName(
        () => repo.install('inst-plugin', 'user-2'),
        'ConflictError',
        'inst-plugin',
      );
    } finally {
      await pool.end();
    }
  });

  test('uninstall by another user succeeds, and rejects unknown (404) or not installed (400)', async () => {
    const { pool, repo } = createTestDb();
    try {
      await assertRejectsName(
        () => repo.uninstall('missing', 'user-1'),
        'NotFoundError',
        'missing',
      );

      await repo.register(makeManifest({ id: 'uninst-plugin' }), 'owner-1');
      await assertRejectsName(
        () => repo.uninstall('uninst-plugin', 'user-1'),
        'BadRequestError',
        'uninst-plugin',
      );

      await repo.install('uninst-plugin', 'user-1');
      const uninstalled = await repo.uninstall('uninst-plugin', 'user-2');
      assert.equal(uninstalled.status, 'available');
      assert.equal(uninstalled.installed_by, 'user-2');
      assert.equal(uninstalled.installed_at, null);
    } finally {
      await pool.end();
    }
  });

  test('delete enforces ownership, allows admin, and rejects unknown (404)', async () => {
    const { pool, repo } = createTestDb();
    try {
      await assertRejectsName(
        () => repo.delete('missing', 'owner-1'),
        'NotFoundError',
        'missing',
      );

      await repo.register(makeManifest({ id: 'owned-plugin' }), 'owner-1');

      await assertRejectsName(
        () => repo.delete('owned-plugin', 'other-user', false),
        'ForbiddenError',
        'owned-plugin',
      );

      // Owner can delete
      await repo.delete('owned-plugin', 'owner-1', false);
      assert.equal(await repo.findById('owned-plugin'), undefined);

      // Admin can delete another user's plugin
      await repo.register(makeManifest({ id: 'admin-del-plugin' }), 'owner-1');
      await repo.delete('admin-del-plugin', 'admin-user', true);
      assert.equal(await repo.findById('admin-del-plugin'), undefined);
    } finally {
      await pool.end();
    }
  });
});
