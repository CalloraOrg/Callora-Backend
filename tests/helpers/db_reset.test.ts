import { createSqliteTestDb, createTestDb, resetTestDb } from './db.js';

describe('Database Reset Helpers', () => {
  describe('resetTestDb (PostgreSQL/pg-mem)', () => {
    let testDb: any;

    beforeEach(() => {
      testDb = createTestDb();
    });

    afterEach(async () => {
      await testDb.end();
    });

    it('should clear data from tables', async () => {
      // 1. Insert some data
      const userRes = await testDb.pool.query(
        "INSERT INTO users (wallet_address) VALUES ('GDTEST123') RETURNING id"
      );
      const userId = userRes.rows[0].id;
      
      const keyRes = await testDb.pool.query(
        "INSERT INTO api_keys (user_id, api_id, key_hash) VALUES ($1, 'test-api', 'hash') RETURNING id",
        [userId]
      );
      const keyId = keyRes.rows[0].id;

      await testDb.pool.query(
        "INSERT INTO usage_logs (api_key_id) VALUES ($1)",
        [keyId]
      );

      // Verify data exists
      const countBefore = await testDb.pool.query('SELECT COUNT(*) FROM usage_logs');
      expect(parseInt(countBefore.rows[0].count)).toBe(1);

      // 2. Reset
      await resetTestDb(testDb.pool);
      await resetTestDb(testDb.pool);

      const replacementUser = await testDb.pool.query(
        "INSERT INTO users (wallet_address) VALUES ('GDRESETINSERT') RETURNING id"
      );
      expect(replacementUser.rows).toHaveLength(1);
      await resetTestDb(testDb.pool);

      // 3. Verify data is gone
      const countAfter = await testDb.pool.query('SELECT COUNT(*) FROM usage_logs');
      expect(parseInt(countAfter.rows[0].count)).toBe(0);
      
      const keyCountAfter = await testDb.pool.query('SELECT COUNT(*) FROM api_keys');
      expect(parseInt(keyCountAfter.rows[0].count)).toBe(0);
      
      const userCountAfter = await testDb.pool.query('SELECT COUNT(*) FROM users');
      expect(parseInt(userCountAfter.rows[0].count)).toBe(0);
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

    it('should clear data from sqlite tables', async () => {
      // 1. Insert some data
      const [dev] = await sqliteTestDb.db.insert(sqliteTestDb.schema.developers)
        .values({ user_id: 'test-user-' + Date.now() })
        .returning();
      
      const [api] = await sqliteTestDb.db.insert(sqliteTestDb.schema.apis)
        .values({
          developer_id: dev.id,
          name: 'Reset Test API',
          base_url: 'https://test.com'
        })
        .returning();

      await sqliteTestDb.db.insert(sqliteTestDb.schema.apiEndpoints)
        .values({
          api_id: api.id,
          path: '/test',
          method: 'GET'
        });

      // Verify data exists
      const apisBefore = await sqliteTestDb.db.select().from(sqliteTestDb.schema.apis);
      expect(apisBefore.length).toBeGreaterThan(0);

      // 2. Reset
      await sqliteTestDb.resetDb();
      await sqliteTestDb.resetDb();

      const [replacementDeveloper] = await sqliteTestDb.db.insert(sqliteTestDb.schema.developers)
        .values({ user_id: 'reset-insert-' + Date.now() })
        .returning();
      expect(replacementDeveloper.id).toBeDefined();
      await sqliteTestDb.resetDb();

      // 3. Verify data is gone
      const apisAfter = await sqliteTestDb.db.select().from(sqliteTestDb.schema.apis);
      expect(apisAfter.length).toBe(0);
      
      const endpointsAfter = await sqliteTestDb.db.select().from(sqliteTestDb.schema.apiEndpoints);
      expect(endpointsAfter.length).toBe(0);
      
      const devsAfter = await sqliteTestDb.db.select().from(sqliteTestDb.schema.developers);
      expect(devsAfter.length).toBe(0);
    });
  });
});
