import { createTestDb, resetTestDb } from './db.js';
import { resetDb } from '../../src/test-db.js';
import { db as sqliteDb, schema as sqliteSchema } from '../../src/db/index.js';

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
    it('should clear data from sqlite tables', async () => {
      // 1. Insert some data
      const [dev] = await sqliteDb.insert(sqliteSchema.developers)
        .values({ user_id: 'test-user-' + Date.now() })
        .returning();
      
      const [api] = await sqliteDb.insert(sqliteSchema.apis)
        .values({
          developer_id: dev.id,
          name: 'Reset Test API',
          base_url: 'https://test.com'
        })
        .returning();

      await sqliteDb.insert(sqliteSchema.apiEndpoints)
        .values({
          api_id: api.id,
          path: '/test',
          method: 'GET'
        });

      // Verify data exists
      const apisBefore = await sqliteDb.select().from(sqliteSchema.apis);
      expect(apisBefore.length).toBeGreaterThan(0);

      // 2. Reset
      await resetDb();

      // 3. Verify data is gone
      const apisAfter = await sqliteDb.select().from(sqliteSchema.apis);
      expect(apisAfter.length).toBe(0);
      
      const endpointsAfter = await sqliteDb.select().from(sqliteSchema.apiEndpoints);
      expect(endpointsAfter.length).toBe(0);
      
      const devsAfter = await sqliteDb.select().from(sqliteSchema.developers);
      expect(devsAfter.length).toBe(0);
    });
  });
});
