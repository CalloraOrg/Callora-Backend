import { createSqliteTestDb, createTestDb, resetTestDb } from './db.js';

describe('Database Reset Robustness', () => {
  describe('resetTestDb (pg-mem)', () => {
    let testDb: any;

    beforeEach(() => {
      testDb = createTestDb();
    });

    afterEach(async () => {
      await testDb.end();
    });

    it('should handle missing tables gracefully', async () => {
      // Create a pool that doesn't have the expected schema
      const { newDb } = await import('pg-mem');
      const emptyDb = newDb();
      const { Pool } = emptyDb.adapters.createPg();
      const pool = new Pool();

      // Should not throw even if tables are missing
      await expect(resetTestDb(pool)).resolves.not.toThrow();
      await pool.end();
    });

    it('should reset data across multiple tables with dependencies', async () => {
      // 1. Insert data with FK relationships
      const userRes = await testDb.pool.query(
        "INSERT INTO users (wallet_address) VALUES ('REL-TEST-1') RETURNING id"
      );
      const userId = userRes.rows[0].id;
      
      const keyRes = await testDb.pool.query(
        "INSERT INTO api_keys (user_id, api_id, key_hash) VALUES ($1, 'api-1', 'hash-1') RETURNING id",
        [userId]
      );
      const keyId = keyRes.rows[0].id;

      await testDb.pool.query(
        "INSERT INTO usage_logs (api_key_id) VALUES ($1)",
        [keyId]
      );

      // 2. Reset
      await resetTestDb(testDb.pool);

      // 3. Verify all tables are empty
      const userCount = await testDb.pool.query('SELECT COUNT(*) FROM users');
      const keyCount = await testDb.pool.query('SELECT COUNT(*) FROM api_keys');
      const usageCount = await testDb.pool.query('SELECT COUNT(*) FROM usage_logs');

      expect(parseInt(userCount.rows[0].count)).toBe(0);
      expect(parseInt(keyCount.rows[0].count)).toBe(0);
      expect(parseInt(usageCount.rows[0].count)).toBe(0);
    });
  });

  describe('resetDb (SQLite)', () => {
    let sqliteTestDb: Awaited<ReturnType<typeof createSqliteTestDb>>;

    beforeAll(async () => {
      sqliteTestDb = await createSqliteTestDb();
    });

    afterAll(async () => {
      await sqliteTestDb.closeDb();
    });

    it('should reset all tables dynamically', async () => {
      // 1. Insert data into all known tables
      const [dev] = await sqliteTestDb.db.insert(sqliteTestDb.schema.developers)
        .values({ user_id: 'dynamic-dev-' + Date.now() })
        .returning();
      
      const [api] = await sqliteTestDb.db.insert(sqliteTestDb.schema.apis)
        .values({
          developer_id: dev.id,
          name: 'Dynamic API',
          base_url: 'https://dynamic.com'
        })
        .returning();

      await sqliteTestDb.db.insert(sqliteTestDb.schema.apiEndpoints)
        .values({
          api_id: api.id,
          path: '/dynamic',
          method: 'GET'
        });

      // 2. Reset
      await sqliteTestDb.resetDb();

      // 3. Verify all tables are empty
      const devs = await sqliteTestDb.db.select().from(sqliteTestDb.schema.developers);
      const apis = await sqliteTestDb.db.select().from(sqliteTestDb.schema.apis);
      const endpoints = await sqliteTestDb.db.select().from(sqliteTestDb.schema.apiEndpoints);

      expect(devs.length).toBe(0);
      expect(apis.length).toBe(0);
      expect(endpoints.length).toBe(0);
    });

    it('should reset auto-increment counters', async () => {
      // 1. Insert and reset to establish state
      await sqliteTestDb.resetDb();
      
      const [dev1] = await sqliteTestDb.db.insert(sqliteTestDb.schema.developers)
        .values({ user_id: 'counter-dev-1' })
        .returning();
      
      const firstId = dev1.id;
      
      await sqliteTestDb.resetDb();
      
      // 2. Insert again - should get the same ID if counter was reset
      const [dev2] = await sqliteTestDb.db.insert(sqliteTestDb.schema.developers)
        .values({ user_id: 'counter-dev-2' })
        .returning();
      
      expect(dev2.id).toBe(firstId);
    });

    it('should handle foreign key constraints correctly during reset', async () => {
      // 1. Setup data with FK
      const [dev] = await sqliteTestDb.db.insert(sqliteTestDb.schema.developers)
        .values({ user_id: 'fk-test-dev' })
        .returning();
      
      await sqliteTestDb.db.insert(sqliteTestDb.schema.apis)
        .values({
          developer_id: dev.id,
          name: 'FK Test API',
          base_url: 'https://fk.com'
        });
      await sqliteTestDb.db.insert(sqliteTestDb.schema.apiEndpoints)
        .values({
          api_id: 1,
          path: '/fk-test',
          method: 'GET'
        });

      // 2. Reset should work without FK violation errors
      await expect(sqliteTestDb.resetDb()).resolves.not.toThrow();
      
      expect(sqliteTestDb.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      await expect(
        () => sqliteTestDb.sqlite.prepare(
          'INSERT INTO api_endpoints (api_id, path, method) VALUES (?, ?, ?)',
        ).run(999999, '/invalid', 'GET'),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });
});
