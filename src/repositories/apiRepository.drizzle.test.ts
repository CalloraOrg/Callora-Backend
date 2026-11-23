import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DrizzleApiRepository as DrizzleApiRepositoryType } from './apiRepository.drizzle.js';

describe('DrizzleApiRepository (SQLite)', () => {
  let dbModule: typeof import('../db/index.js');
  let repo: DrizzleApiRepositoryType;
  let dev1Id: number;
  let dev2Id: number;

  beforeAll(async () => {
    process.env.SQLITE_PATH = ':memory:';
    dbModule = await import('../db/index.js');

    // Apply the API/developer migrations directly rather than initializeDb()
    // because unrelated unprefixed SQL files in migrations/ cause discoverMigrations to throw.
    const migrationsDir = path.join(process.cwd(), 'migrations');
    for (const file of [
      '0000_initial_apis_tables.sql',
      '0004_create_developers.sql',
      '0012_api_endpoints_cascade.sql',
      '0015_apis_soft_delete.sql',
    ]) {
      dbModule.sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
    dbModule.sqlite.pragma('foreign_keys = ON');

    const { DrizzleApiRepository } = await import('./apiRepository.drizzle.js');
    repo = new DrizzleApiRepository();

    const insertDev = dbModule.sqlite.prepare(
      'INSERT INTO developers (user_id, name, website, description) VALUES (?, ?, ?, ?)',
    );
    dev1Id = Number(
      insertDev.run('user-drizzle-1', 'Alice Dev', 'https://alice.example.com', 'Alice APIs').lastInsertRowid,
    );
    dev2Id = Number(
      insertDev.run('user-drizzle-2', 'Bob Dev', 'https://bob.example.com', 'Bob APIs').lastInsertRowid,
    );
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.schema.apiEndpoints);
    await dbModule.db.delete(dbModule.schema.apis);
  });

  afterAll(async () => {
    await dbModule.closeDb();
  });

  describe('create and update', () => {
    it('applies create defaults (status: "draft", nullable fields)', async () => {
      const created = await repo.create({
        developer_id: dev1Id,
        name: 'Weather API',
        base_url: 'https://weather.example.com',
      });

      expect(created.id).toBeGreaterThan(0);
      expect(created.developer_id).toBe(dev1Id);
      expect(created.name).toBe('Weather API');
      expect(created.base_url).toBe('https://weather.example.com');
      expect(created.status).toBe('draft');
      expect(created.description).toBeNull();
      expect(created.logo_url).toBeNull();
      expect(created.category).toBeNull();
      expect(created.deleted_at).toBeNull();
    });

    it('supports partial update, empty payload returning row unchanged, and null for unknown id', async () => {
      const created = await repo.create({
        developer_id: dev1Id,
        name: 'Billing API',
        base_url: 'https://billing.example.com',
        category: 'finance',
      });

      const unchanged = await repo.update(created.id, {});
      expect(unchanged).not.toBeNull();
      expect(unchanged!.name).toBe('Billing API');
      expect(unchanged!.category).toBe('finance');

      const updated = await repo.update(created.id, {
        name: 'Billing v2',
        status: 'active',
        description: 'Updated desc',
      });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Billing v2');
      expect(updated!.status).toBe('active');
      expect(updated!.description).toBe('Updated desc');
      expect(updated!.category).toBe('finance');

      const missing = await repo.update(999_999, { name: 'Nope' });
      expect(missing).toBeNull();
    });

    it('allows two APIs with the same name for different developers', async () => {
      const a1 = await repo.create({
        developer_id: dev1Id,
        name: 'Shared Name',
        base_url: 'https://a.example.com',
      });
      const a2 = await repo.create({
        developer_id: dev2Id,
        name: 'Shared Name',
        base_url: 'https://b.example.com',
      });

      expect(a1.id).not.toBe(a2.id);
      expect(a1.developer_id).toBe(dev1Id);
      expect(a2.developer_id).toBe(dev2Id);
    });
  });

  describe('createWithEndpoints, bulkCreateEndpoints, and getEndpoints', () => {
    it('creates an API with endpoints atomically and returns both', async () => {
      const created = await repo.createWithEndpoints({
        developer_id: dev1Id,
        name: 'Payments API',
        base_url: 'https://payments.example.com',
        status: 'active',
        endpoints: [
          {
            path: '/charge',
            method: 'POST',
            price_per_call_usdc: '0.05',
            description: 'Create charge',
          },
          {
            path: '/status',
            method: 'GET',
            price_per_call_usdc: '0.01',
          },
        ],
      });

      expect(created.id).toBeGreaterThan(0);
      expect(created.endpoints).toHaveLength(2);
      expect(created.endpoints[0]).toMatchObject({
        api_id: created.id,
        path: '/charge',
        method: 'POST',
        price_per_call_usdc: '0.05',
        description: 'Create charge',
      });
      expect(created.endpoints[1]).toMatchObject({
        api_id: created.id,
        path: '/status',
        method: 'GET',
        price_per_call_usdc: '0.01',
        description: null,
      });

      const endpoints = await repo.getEndpoints(created.id);
      expect(endpoints).toHaveLength(2);
      expect(endpoints[0]).toEqual({
        path: '/charge',
        method: 'POST',
        price_per_call_usdc: '0.05',
        description: 'Create charge',
      });
    });

    it('bulkCreateEndpoints inserts endpoints and returns BulkCreateEndpointResult[]', async () => {
      const api = await repo.create({
        developer_id: dev1Id,
        name: 'Bulk API',
        base_url: 'https://bulk.example.com',
      });

      const inserted = await repo.bulkCreateEndpoints(api.id, [
        { path: '/one', method: 'GET', price_per_call_usdc: '0.01' },
        { path: '/two', method: 'POST', price_per_call_usdc: '0.02', description: 'Two' },
      ]);

      expect(inserted).toHaveLength(2);
      expect(inserted[0]).toMatchObject({
        api_id: api.id,
        path: '/one',
        method: 'GET',
        price_per_call_usdc: '0.01',
        description: null,
      });
      expect(typeof inserted[0]!.id).toBe('number');
    });
  });

  describe('listByDeveloper, listPublic, and findById', () => {
    it('filters listByDeveloper by status, category, search (including %), limit without offset, and offset', async () => {
      await repo.create({
        developer_id: dev1Id,
        name: 'Alpha 100% API',
        base_url: 'https://a.example.com',
        category: 'ai',
        status: 'active',
      });
      await repo.create({
        developer_id: dev1Id,
        name: 'Beta API',
        base_url: 'https://b.example.com',
        category: 'ai',
        status: 'draft',
      });
      await repo.create({
        developer_id: dev1Id,
        name: 'Gamma API',
        base_url: 'https://g.example.com',
        category: 'data',
        status: 'active',
      });
      await repo.create({
        developer_id: dev2Id,
        name: 'Other Dev API',
        base_url: 'https://o.example.com',
        category: 'ai',
        status: 'active',
      });

      expect(await repo.listByDeveloper(dev1Id)).toHaveLength(3);
      expect(await repo.listByDeveloper(dev1Id, { status: 'active' })).toHaveLength(2);
      expect(await repo.listByDeveloper(dev1Id, { category: 'ai' })).toHaveLength(2);
      expect(await repo.listByDeveloper(dev1Id, { search: '100%' })).toHaveLength(1);

      const limited = await repo.listByDeveloper(dev1Id, { limit: 2 });
      expect(limited).toHaveLength(2);

      const paged = await repo.listByDeveloper(dev1Id, { limit: 1, offset: 1 });
      expect(paged).toHaveLength(1);
    });

    it('listPublic returns only active APIs and returns [] when status is "draft"', async () => {
      await repo.create({
        developer_id: dev1Id,
        name: 'Public Active',
        base_url: 'https://pub.example.com',
        category: 'tools',
        status: 'active',
      });
      await repo.create({
        developer_id: dev1Id,
        name: 'Private Draft',
        base_url: 'https://priv.example.com',
        category: 'tools',
        status: 'draft',
      });

      expect(await repo.listPublic({ status: 'draft' })).toEqual([]);
      const pub = await repo.listPublic({ category: 'tools', search: 'Public' });
      expect(pub).toHaveLength(1);
      expect(pub[0]!.name).toBe('Public Active');
    });

    it('findById only returns active APIs with developer info', async () => {
      const draft = await repo.create({
        developer_id: dev1Id,
        name: 'Draft API',
        base_url: 'https://draft.example.com',
        status: 'draft',
      });
      expect(await repo.findById(draft.id)).toBeNull();
      expect(await repo.findRawById(draft.id)).not.toBeNull();

      const active = await repo.create({
        developer_id: dev1Id,
        name: 'Live API',
        base_url: 'https://live.example.com',
        status: 'active',
      });
      const details = await repo.findById(active.id);
      expect(details).toEqual({
        id: active.id,
        name: 'Live API',
        description: null,
        base_url: 'https://live.example.com',
        logo_url: null,
        category: null,
        status: 'active',
        developer: {
          name: 'Alice Dev',
          website: 'https://alice.example.com',
          description: 'Alice APIs',
        },
      });
    });
  });

  describe('delete (hard delete + cascade) and restore semantics', () => {
    /**
     * Note: Unlike `defaultApiRepository` (in `src/repositories/apiRepository.ts`),
     * which performs soft-deletes by setting `deleted_at` and filters `isNull(deleted_at)`,
     * `DrizzleApiRepository.delete()` issues a hard `DELETE` relying on `ON DELETE CASCADE`
     * for `api_endpoints`, while `restore()` only updates rows where `deleted_at IS NOT NULL`.
     */
    it('hard-deletes the API, cascades to api_endpoints, and returns false on repeat/missing delete', async () => {
      const created = await repo.createWithEndpoints({
        developer_id: dev1Id,
        name: 'Cascade API',
        base_url: 'https://cascade.example.com',
        endpoints: [
          { path: '/ping', method: 'GET', price_per_call_usdc: '0.01' },
        ],
      });

      expect(await repo.delete(created.id)).toBe(true);
      expect(await repo.delete(created.id)).toBe(false);
      expect(await repo.delete(999_999)).toBe(false);

      expect(await repo.findRawById(created.id)).toBeNull();
      const remainingEndpoints = await dbModule.db
        .select()
        .from(dbModule.schema.apiEndpoints)
        .where(eq(dbModule.schema.apiEndpoints.api_id, created.id));
      expect(remainingEndpoints).toEqual([]);
    });

    it('restore returns null when deleted_at is null and clears deleted_at when set', async () => {
      const api = await repo.create({
        developer_id: dev1Id,
        name: 'Restorable API',
        base_url: 'https://restore.example.com',
      });

      expect(await repo.restore(api.id)).toBeNull();

      await dbModule.db
        .update(dbModule.schema.apis)
        .set({ deleted_at: new Date() })
        .where(eq(dbModule.schema.apis.id, api.id));

      const restored = await repo.restore(api.id);
      expect(restored).not.toBeNull();
      expect(restored!.deleted_at).toBeNull();
    });
  });
});
