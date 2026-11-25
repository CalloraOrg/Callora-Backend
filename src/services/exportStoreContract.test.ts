import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { InMemoryExportStore, type DeveloperExportRecord, type DeveloperExportStore } from './reportExporter.js';
import { PostgresExportStore } from './postgresExportStore.js';

// The same behavioural table runs against every DeveloperExportStore. The
// Postgres variant needs DATABASE_URL and is skipped otherwise. Use developer
// ids that start with "contract-" so cleanup only touches these rows.

const NOW = new Date('2026-06-03T00:00:00.000Z');

function record(overrides: Partial<DeveloperExportRecord>): DeveloperExportRecord {
  return {
    id: 'exp-a',
    developerId: 'contract-dev',
    format: 'csv',
    s3Key: 'daily-exports/contract-dev/2026-06-02.csv',
    exportedAt: new Date('2026-06-02T00:00:00.000Z'),
    expiresAt: new Date('2026-06-09T00:00:00.000Z'),
    ...overrides,
  };
}

interface Harness {
  store: DeveloperExportStore;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

function contract(label: string, setup: () => Promise<Harness>) {
  describe(`${label} export store contract`, () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await setup();
      await harness.reset();
    });
    afterEach(async () => {
      await harness.reset();
      await harness.close();
    });

    test('two concurrent claims for the same day: exactly one wins', async () => {
      const results = await Promise.all([
        harness.store.claimDay('contract-dev', '2026-06-01'),
        harness.store.claimDay('contract-dev', '2026-06-01'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('a claimed day is refused even with force', async () => {
      await harness.store.claimDay('contract-dev', '2026-06-01');
      await expect(harness.store.claimDay('contract-dev', '2026-06-01', true)).resolves.toBe(false);
    });

    test('a completed day is refused unless forced', async () => {
      await harness.store.claimDay('contract-dev', '2026-06-01');
      await harness.store.completeDay('contract-dev', '2026-06-01');
      await expect(harness.store.claimDay('contract-dev', '2026-06-01')).resolves.toBe(false);
      await expect(harness.store.claimDay('contract-dev', '2026-06-01', true)).resolves.toBe(true);
    });

    test('releaseDay reopens a claimed day but not a completed one', async () => {
      await harness.store.claimDay('contract-dev', '2026-06-01');
      await harness.store.releaseDay('contract-dev', '2026-06-01');
      await expect(harness.store.claimDay('contract-dev', '2026-06-01')).resolves.toBe(true);

      await harness.store.completeDay('contract-dev', '2026-06-01');
      await harness.store.releaseDay('contract-dev', '2026-06-01');
      await expect(harness.store.claimDay('contract-dev', '2026-06-01')).resolves.toBe(false);
    });

    test('saving the same developer and s3Key replaces the record', async () => {
      await harness.store.save(record({ id: 'exp-a' }));
      await harness.store.save(record({ id: 'exp-b' }));

      const listed = await harness.store.listByDeveloper('contract-dev', { limit: 10, now: NOW });
      expect(listed.map((r) => r.id)).toEqual(['exp-b']);
    });

    test('listByDeveloper hides expired records and filters by format', async () => {
      await harness.store.save(record({ id: 'exp-csv', format: 'csv', s3Key: 'a.csv' }));
      await harness.store.save(record({ id: 'exp-json', format: 'json', s3Key: 'a.json' }));
      await harness.store.save(record({
        id: 'exp-old',
        s3Key: 'old.csv',
        exportedAt: new Date('2026-05-01T00:00:00.000Z'),
        expiresAt: new Date('2026-05-08T00:00:00.000Z'),
      }));

      const json = await harness.store.listByDeveloper('contract-dev', { limit: 10, now: NOW, format: 'json' });
      expect(json.map((r) => r.id)).toEqual(['exp-json']);

      const all = await harness.store.listByDeveloper('contract-dev', { limit: 10, now: NOW });
      expect(all.map((r) => r.id).sort()).toEqual(['exp-csv', 'exp-json']);
    });

    test('keyset cursor pages newest first without repeating or skipping records', async () => {
      await harness.store.save(record({ id: 'exp-1', s3Key: '1', exportedAt: new Date('2026-06-02T00:00:00.000Z') }));
      await harness.store.save(record({ id: 'exp-2', s3Key: '2', exportedAt: new Date('2026-06-02T00:00:00.000Z') }));
      await harness.store.save(record({ id: 'exp-3', s3Key: '3', exportedAt: new Date('2026-06-01T12:00:00.000Z') }));

      const first = await harness.store.listByDeveloper('contract-dev', { limit: 2, now: NOW });
      const last = first[first.length - 1]!;
      const second = await harness.store.listByDeveloper('contract-dev', {
        limit: 2,
        now: NOW,
        cursor: { exportedAt: last.exportedAt, id: last.id },
      });

      const ids = [...first, ...second].map((r) => r.id);
      expect(ids).toEqual(['exp-2', 'exp-1', 'exp-3']);
    });

    test('getById returns a saved record and nothing for an unknown id', async () => {
      await harness.store.save(record({ id: 'exp-get' }));
      expect((await harness.store.getById('exp-get'))?.s3Key).toBe(record({}).s3Key);
      await expect(harness.store.getById('missing')).resolves.toBeUndefined();
    });
  });
}

contract('InMemoryExportStore', async () => ({
  store: new InMemoryExportStore(),
  reset: async () => undefined,
  close: async () => undefined,
}));

const migrationsDir = path.join(process.cwd(), 'migrations');

(process.env.DATABASE_URL ? describe : describe.skip)('PostgresExportStore against a database', () => {
  contract('PostgresExportStore', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(readFileSync(path.join(migrationsDir, '0017_developer_exports.sql'), 'utf8'));
    await pool.query(readFileSync(path.join(migrationsDir, '0033_developer_export_claims.sql'), 'utf8'));
    const reset = async () => {
      await pool.query(`DELETE FROM developer_export_claims WHERE developer_id LIKE 'contract-%'`);
      await pool.query(`DELETE FROM developer_exports WHERE developer_id LIKE 'contract-%'`);
    };
    return {
      store: new PostgresExportStore({ query: (t, p) => pool.query(t, p) as never }, { query: (t, p) => pool.query(t, p) as never }),
      reset,
      close: async () => { await pool.end(); },
    };
  });
});
