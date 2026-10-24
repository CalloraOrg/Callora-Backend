import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { PostgresForwardedIdentityReplayStore } from "../../src/services/forwardedIdentityReplayStore.js";

// Opt in with a disposable PostgreSQL database. CI for this issue supplies one.
const databaseUrl = process.env.TEST_FORWARDED_REPLAY_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
describePostgres("PostgreSQL forwarded replay claims", () => {
  const schema = `forwarded_replay_${process.pid}_${Date.now()}`;
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
  const store = new PostgresForwardedIdentityReplayStore((sql, values) => pool.query(sql, values));
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(readFileSync("migrations/0026_forwarded_identity_replays.sql", "utf8"));
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
  test("only one of twenty concurrent instances wins; boundary retained, expired rows reclaimed", async () => {
    const signature = "a".repeat(64);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(signature, 2000, 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.claim(signature, 3000, 2000)).toBe(false);
    expect(await store.claim(signature, 3000, 2001)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM forwarded_identity_replays")).rows[0].count).toBe(1);
  });
});
