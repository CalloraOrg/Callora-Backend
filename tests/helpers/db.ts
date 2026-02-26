import { newDb, DataType } from 'pg-mem';

export function createTestDb() {
  const db = newDb();

  let counter = 0;
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => {
      counter++;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, '0')}`;
    },
  });

  db.public.none(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_address TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      api_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      revoked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_key_id UUID REFERENCES api_keys(id),
      called_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    pool,
    async end() {
      await pool.end();
    },
  };
}
