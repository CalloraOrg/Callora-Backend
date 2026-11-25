import { PostgresExportStore } from './postgresExportStore.js';
import type { DeveloperExportRecord } from './reportExporter.js';
import type { Queryable } from '../db.js';

function mockDb(rows: unknown[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as Queryable & { query: jest.Mock };
}

const record: DeveloperExportRecord = {
  id: 'exp-1',
  developerId: 'dev-1',
  format: 'csv',
  s3Key: 'daily-exports/dev-1/2026-06-01.csv',
  exportedAt: new Date('2026-06-02T00:00:00.000Z'),
  expiresAt: new Date('2026-06-09T00:00:00.000Z'),
};

describe('PostgresExportStore', () => {
  test('claimDay is one atomic upsert that refuses claimed days and completed days unless forced', async () => {
    const db = mockDb([{ state: 'claimed' }]);
    const store = new PostgresExportStore(db, db);

    await expect(store.claimDay('dev-1', '2026-06-01')).resolves.toBe(true);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(developer_id, day\) DO UPDATE/);
    expect(sql).toMatch(/developer_export_claims\.state <> 'claimed'/);
    expect(sql).toMatch(/developer_export_claims\.state <> 'completed' OR \$3::boolean/);
    expect(params).toEqual(['dev-1', '2026-06-01', false]);
  });

  test('claimDay returns false when the guard rejects the transition (no row returned)', async () => {
    const store = new PostgresExportStore(mockDb([]), mockDb([]));
    await expect(store.claimDay('dev-1', '2026-06-01')).resolves.toBe(false);
  });

  test('claimDay passes force through to the completed-day guard', async () => {
    const db = mockDb([{ state: 'claimed' }]);
    await new PostgresExportStore(db, db).claimDay('dev-1', '2026-06-01', true);
    expect(db.query.mock.calls[0][1]).toEqual(['dev-1', '2026-06-01', true]);
  });

  test('releaseDay deletes only a claim that is still claimed', async () => {
    const db = mockDb();
    await new PostgresExportStore(db, db).releaseDay('dev-1', '2026-06-01');

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM developer_export_claims/);
    expect(sql).toMatch(/state = 'claimed'/);
    expect(params).toEqual(['dev-1', '2026-06-01']);
  });

  test('completeDay upserts the claim as completed', async () => {
    const db = mockDb();
    await new PostgresExportStore(db, db).completeDay('dev-1', '2026-06-01');

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/'completed'/);
    expect(sql).toMatch(/ON CONFLICT \(developer_id, day\) DO UPDATE/);
    expect(params).toEqual(['dev-1', '2026-06-01']);
  });

  test('save upserts on (developer_id, s3_key) and returns the stored row', async () => {
    const db = mockDb([{
      id: 'exp-1',
      developer_id: 'dev-1',
      format: 'csv',
      s3_key: record.s3Key,
      exported_at: '2026-06-02T00:00:00.000Z',
      expires_at: '2026-06-09T00:00:00.000Z',
    }]);

    const saved = await new PostgresExportStore(db, db).save(record);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(developer_id, s3_key\) DO UPDATE/);
    expect(params).toEqual([
      'exp-1', 'dev-1', 'csv', record.s3Key,
      '2026-06-02T00:00:00.000Z', '2026-06-09T00:00:00.000Z',
    ]);
    expect(saved).toEqual(record);
  });

  test('save fails explicitly when the write returns no row', async () => {
    const store = new PostgresExportStore(mockDb([]), mockDb([]));
    await expect(store.save(record)).rejects.toThrow('Export record save did not return a row');
  });

  test('listByDeveloper binds the expiry clock, filters and keyset cursor, and ignores offset when a cursor is given', async () => {
    const readDb = mockDb([{
      id: 'exp-0',
      developer_id: 'dev-1',
      format: 'json',
      s3_key: 'k',
      exported_at: '2026-06-01T00:00:00.000Z',
      expires_at: '2026-06-08T00:00:00.000Z',
    }]);
    const store = new PostgresExportStore(mockDb(), readDb);
    const cursor = { exportedAt: new Date('2026-06-02T00:00:00.000Z'), id: 'exp-1' };

    const rows = await store.listByDeveloper('dev-1', {
      limit: 10,
      offset: 5,
      now: new Date('2026-06-03T00:00:00.000Z'),
      format: 'json',
      cursor,
    });

    const [sql, params] = readDb.query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY exported_at COLLATE "C" DESC, id COLLATE "C" DESC/);
    expect(sql).toMatch(/expires_at COLLATE "C" > \$2::text COLLATE "C"/);
    expect(params).toEqual([
      'dev-1',
      '2026-06-03T00:00:00.000Z',
      'json',
      '2026-06-02T00:00:00.000Z',
      'exp-1',
      10,
      0,
    ]);
    expect(rows[0]).toEqual({
      id: 'exp-0',
      developerId: 'dev-1',
      format: 'json',
      s3Key: 'k',
      exportedAt: new Date('2026-06-01T00:00:00.000Z'),
      expiresAt: new Date('2026-06-08T00:00:00.000Z'),
    });
  });

  test('listByDeveloper applies offset and leaves format and cursor unbound when not given', async () => {
    const readDb = mockDb([]);
    await new PostgresExportStore(mockDb(), readDb).listByDeveloper('dev-1', {
      limit: 10,
      offset: 5,
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    expect(readDb.query.mock.calls[0][1]).toEqual([
      'dev-1', '2026-06-03T00:00:00.000Z', null, null, null, 10, 5,
    ]);
  });

  test('reads go through the read-side query and writes through the write-side query', async () => {
    const writes = mockDb([{ state: 'claimed' }]);
    const reads = mockDb([]);
    const store = new PostgresExportStore(writes, reads);

    await store.claimDay('dev-1', '2026-06-01');
    await store.getById('exp-1');

    expect(writes.query).toHaveBeenCalledTimes(1);
    expect(reads.query).toHaveBeenCalledTimes(1);
  });
});
