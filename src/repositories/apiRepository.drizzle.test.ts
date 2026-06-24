import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function createLegacyApiTables(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE apis (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      developer_id integer NOT NULL,
      name text NOT NULL,
      description text,
      base_url text NOT NULL,
      logo_url text,
      category text,
      status text DEFAULT 'draft' NOT NULL,
      created_at integer DEFAULT (unixepoch()) NOT NULL,
      updated_at integer DEFAULT (unixepoch()) NOT NULL
    );

    CREATE TABLE api_endpoints (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      api_id integer NOT NULL,
      path text NOT NULL,
      method text DEFAULT 'GET' NOT NULL,
      price_per_call_usdc text DEFAULT '0.01' NOT NULL,
      description text,
      created_at integer DEFAULT (unixepoch()) NOT NULL,
      updated_at integer DEFAULT (unixepoch()) NOT NULL,
      FOREIGN KEY (api_id) REFERENCES apis(id)
    );

    CREATE INDEX idx_api_endpoints_api_id ON api_endpoints (api_id);
  `);
}

function readMigration(filename: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'migrations', filename), 'utf8');
}

function apiEndpointForeignKey(db: Database.Database): { on_delete: string } {
  const row = db
    .prepare("PRAGMA foreign_key_list('api_endpoints')")
    .all()
    .find((entry) => {
      const fk = entry as { table: string; from: string };
      return fk.table === 'apis' && fk.from === 'api_id';
    });

  if (!row) throw new Error('api_endpoints.api_id foreign key not found');
  return row as { on_delete: string };
}

describe('api_endpoints cascade migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createLegacyApiTables(db);
  });

  afterEach(() => {
    db.close();
  });

  test('deleting an API cascades to its endpoints after migration', () => {
    db.exec(readMigration('0012_api_endpoints_cascade.sql'));

    expect(apiEndpointForeignKey(db).on_delete.toUpperCase()).toBe('CASCADE');

    db.exec(`
      INSERT INTO apis (id, developer_id, name, base_url, status)
      VALUES (1, 42, 'Weather', 'https://weather.test', 'active');

      INSERT INTO api_endpoints (id, api_id, path, method, price_per_call_usdc)
      VALUES (10, 1, '/forecast', 'GET', '0.01');
    `);

    db.prepare('DELETE FROM apis WHERE id = ?').run(1);

    const orphanCount = db
      .prepare('SELECT COUNT(*) AS count FROM api_endpoints WHERE api_id = ?')
      .get(1) as { count: number };

    expect(orphanCount.count).toBe(0);
  });

  test('down migration restores the non-cascading foreign key', () => {
    db.exec(readMigration('0012_api_endpoints_cascade.sql'));
    db.exec(readMigration('0012_api_endpoints_cascade.down.sql'));

    expect(apiEndpointForeignKey(db).on_delete.toUpperCase()).toBe('NO ACTION');
  });
});

