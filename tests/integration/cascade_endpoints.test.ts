import { newDb, DataType } from 'pg-mem';

// ---------------------------------------------------------------------------
// In-memory DB factory — mirrors the cascade behaviour from
// migrations/0012_api_endpoints_cascade.sql but expressed in PostgreSQL DDL
// so pg-mem can enforce ON DELETE CASCADE in tests.
// ---------------------------------------------------------------------------
function createCascadeTestDb() {
  const db = newDb();

  let counter = Math.floor(Math.random() * 1_000_000);
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => {
      counter++;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, '0')}`;
    },
  });

  db.public.none(`
    CREATE TABLE apis (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE api_endpoints (
      id       SERIAL PRIMARY KEY,
      api_id   INTEGER NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
      path     TEXT NOT NULL,
      method   TEXT NOT NULL DEFAULT 'GET'
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    db,
    pool,
    async end() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function insertApi(pool: any, name: string): Promise<number> {
  const res = await pool.query(
    `INSERT INTO apis (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return res.rows[0].id as number;
}

async function insertEndpoint(
  pool: any,
  apiId: number,
  path: string,
  method = 'GET',
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO api_endpoints (api_id, path, method) VALUES ($1, $2, $3) RETURNING id`,
    [apiId, path, method],
  );
  return res.rows[0].id as number;
}

async function countEndpoints(pool: any, apiId: number): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*) AS cnt FROM api_endpoints WHERE api_id = $1`,
    [apiId],
  );
  return parseInt(res.rows[0].cnt, 10);
}

async function countOrphans(pool: any): Promise<number> {
  // Use LEFT JOIN instead of NOT EXISTS — both are equivalent but
  // pg-mem (used in tests) handles LEFT JOIN more reliably.
  const res = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM api_endpoints
    LEFT JOIN apis ON apis.id = api_endpoints.api_id
    WHERE apis.id IS NULL
  `);
  return parseInt(res.rows[0].cnt, 10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('api_endpoints cascade delete', () => {
  let db: ReturnType<typeof createCascadeTestDb>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;

  beforeEach(() => {
    db = createCascadeTestDb();
    pool = db.pool;
  });

  afterEach(async () => {
    await db.end();
  });

  it('deleting an api cascades to delete its endpoints', async () => {
    const apiId = await insertApi(pool, 'Weather API');
    await insertEndpoint(pool, apiId, '/forecast');
    await insertEndpoint(pool, apiId, '/current');

    expect(await countEndpoints(pool, apiId)).toBe(2);

    await pool.query(`DELETE FROM apis WHERE id = $1`, [apiId]);

    expect(await countEndpoints(pool, apiId)).toBe(0);
  });

  it('endpoints from other apis are not affected', async () => {
    const api1 = await insertApi(pool, 'API One');
    const api2 = await insertApi(pool, 'API Two');

    await insertEndpoint(pool, api1, '/a');
    await insertEndpoint(pool, api1, '/b');
    await insertEndpoint(pool, api2, '/x');
    await insertEndpoint(pool, api2, '/y');

    // Delete only the first API
    await pool.query(`DELETE FROM apis WHERE id = $1`, [api1]);

    expect(await countEndpoints(pool, api1)).toBe(0);
    // API Two's endpoints must be untouched
    expect(await countEndpoints(pool, api2)).toBe(2);
  });

  it('orphan check — no api_endpoints exist without a valid api_id', async () => {
    const api1 = await insertApi(pool, 'Transient API');
    await insertEndpoint(pool, api1, '/v1/data');

    // Before deletion there should be no orphans
    expect(await countOrphans(pool)).toBe(0);

    await pool.query(`DELETE FROM apis WHERE id = $1`, [api1]);

    // After deletion the cascade must have removed the endpoint, so still 0
    expect(await countOrphans(pool)).toBe(0);
  });

  it('cascade works with multiple endpoints — api with 5 endpoints, delete api, assert all 5 are gone', async () => {
    const apiId = await insertApi(pool, 'Bulk Endpoint API');

    const paths = ['/ep1', '/ep2', '/ep3', '/ep4', '/ep5'];
    for (const p of paths) {
      await insertEndpoint(pool, apiId, p);
    }

    expect(await countEndpoints(pool, apiId)).toBe(5);

    await pool.query(`DELETE FROM apis WHERE id = $1`, [apiId]);

    expect(await countEndpoints(pool, apiId)).toBe(0);
  });
});
