import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DataType, newDb } from 'pg-mem';
import {
  HmacObjectStorageClient,
  InMemoryScheduleStore,
  ScheduledExportsService,
  type ExportSchedule,
  type ScheduleStore,
} from './scheduledExports.js';
import { PostgresScheduleStore, type ScheduleStoreQueryable } from './postgresScheduleStore.js';

const MIGRATION_SQL = fs.readFileSync(
  path.resolve(process.cwd(), 'migrations/0033_export_schedules.sql'),
  'utf8',
);

function createPgMemPool() {
  const db = newDb();
  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamptz,
    implementation: () => new Date('2026-06-01T00:00:00.000Z'),
  });
  db.public.none(MIGRATION_SQL);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return pool as ScheduleStoreQueryable & { end(): Promise<void> };
}

function makeSchedule(overrides: Partial<ExportSchedule> = {}): ExportSchedule {
  const createdAt = overrides.createdAt ?? new Date('2026-06-01T00:00:00.000Z');
  return {
    id: overrides.id ?? 'sched-1',
    developerId: overrides.developerId ?? 'dev-1',
    name: overrides.name ?? 'Daily export',
    cron: overrides.cron ?? '0 0 * * *',
    s3Bucket: overrides.s3Bucket ?? 'exports-bucket',
    s3Region: overrides.s3Region ?? 'us-east-1',
    s3Endpoint: overrides.s3Endpoint ?? 'https://s3.example.com',
    s3AccessKeyId: overrides.s3AccessKeyId ?? 'AKIAEXAMPLE',
    s3SecretAccessKey: overrides.s3SecretAccessKey ?? 'super-secret-value',
    s3PathPrefix: overrides.s3PathPrefix ?? 'reports/daily',
    enabled: overrides.enabled ?? true,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...(overrides.lastRunAt !== undefined ? { lastRunAt: overrides.lastRunAt } : {}),
    nextRunAt: overrides.nextRunAt ?? new Date('2026-06-02T00:00:00.000Z'),
  };
}

function runScheduleStoreContractTests(
  label: string,
  factory: () => Promise<{ store: ScheduleStore; cleanup: () => Promise<void> }>,
) {
  describe(`${label} contract`, () => {
    test('saves, retrieves by id, and round-trips encrypted secrets', async () => {
      const { store, cleanup } = await factory();
      try {
        const input = makeSchedule({
          id: 'sched-roundtrip',
          s3SecretAccessKey: 'my-plain-s3-secret-123',
        });
        await store.save(input);

        const fetched = await store.getById('sched-roundtrip');
        assert.ok(fetched);
        assert.equal(fetched.id, input.id);
        assert.equal(fetched.developerId, input.developerId);
        assert.equal(fetched.name, input.name);
        assert.equal(fetched.cron, input.cron);
        assert.equal(fetched.s3Bucket, input.s3Bucket);
        assert.equal(fetched.s3Region, input.s3Region);
        assert.equal(fetched.s3Endpoint, input.s3Endpoint);
        assert.equal(fetched.s3AccessKeyId, input.s3AccessKeyId);
        assert.equal(fetched.s3SecretAccessKey, 'my-plain-s3-secret-123');
        assert.equal(fetched.s3PathPrefix, input.s3PathPrefix);
        assert.equal(fetched.enabled, true);
        assert.equal(fetched.lastRunAt, undefined);
        assert.deepEqual(fetched.createdAt, input.createdAt);
        assert.deepEqual(fetched.nextRunAt, input.nextRunAt);

        assert.equal(await store.getById('does-not-exist'), undefined);
      } finally {
        await cleanup();
      }
    });

    test('lists schedules ordered by createdAt ASC including disabled schedules', async () => {
      const { store, cleanup } = await factory();
      try {
        await store.save(
          makeSchedule({
            id: 'sched-late',
            name: 'Late',
            createdAt: new Date('2026-06-03T00:00:00.000Z'),
            enabled: true,
          }),
        );
        await store.save(
          makeSchedule({
            id: 'sched-early',
            name: 'Early disabled',
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
            enabled: false,
          }),
        );
        await store.save(
          makeSchedule({
            id: 'sched-mid',
            name: 'Middle',
            createdAt: new Date('2026-06-02T00:00:00.000Z'),
            enabled: true,
          }),
        );

        const listed = await store.list();
        assert.deepEqual(
          listed.map((s) => s.id),
          ['sched-early', 'sched-mid', 'sched-late'],
        );
        assert.equal(listed[0]?.enabled, false);
        assert.equal(listed[1]?.enabled, true);
      } finally {
        await cleanup();
      }
    });

    test('update merges partial fields, bumps updatedAt, and returns undefined for missing id', async () => {
      const { store, cleanup } = await factory();
      try {
        assert.equal(await store.update('missing-id', { name: 'Nope' }), undefined);

        const initialUpdatedAt = new Date('2026-06-01T00:00:00.000Z');
        await store.save(
          makeSchedule({
            id: 'sched-upd',
            name: 'Original',
            enabled: true,
            updatedAt: initialUpdatedAt,
            s3SecretAccessKey: 'initial-secret',
          }),
        );

        const lastRunAt = new Date('2026-06-01T01:00:00.000Z');
        const updated = await store.update('sched-upd', {
          name: 'Renamed',
          enabled: false,
          lastRunAt,
          s3SecretAccessKey: 'rotated-secret',
        });

        assert.ok(updated);
        assert.equal(updated.name, 'Renamed');
        assert.equal(updated.enabled, false);
        assert.deepEqual(updated.lastRunAt, lastRunAt);
        assert.equal(updated.s3SecretAccessKey, 'rotated-secret');
        assert.ok(updated.updatedAt.getTime() > initialUpdatedAt.getTime());

        const reloaded = await store.getById('sched-upd');
        assert.ok(reloaded);
        assert.equal(reloaded.name, 'Renamed');
        assert.equal(reloaded.enabled, false);
        assert.deepEqual(reloaded.lastRunAt, lastRunAt);
        assert.equal(reloaded.s3SecretAccessKey, 'rotated-secret');
      } finally {
        await cleanup();
      }
    });

    test('runDueSchedules picks up persisted nextRunAt, skips disabled schedules, and persists lastRunAt', async () => {
      const { store, cleanup } = await factory();
      try {
        const storage = new HmacObjectStorageClient();
        const service = new ScheduledExportsService(
          { findByApiId: async () => [] },
          store,
          storage,
        );

        const due = await service.createSchedule({
          developerId: 'dev-1',
          name: 'Due export',
          cron: '0 * * * *',
          s3Bucket: 'exports',
          s3Region: 'us-east-1',
          s3Endpoint: 'https://s3.example.com',
          s3AccessKeyId: 'akid',
          s3SecretAccessKey: 'secret-1',
          enabled: true,
        });
        const disabled = await service.createSchedule({
          developerId: 'dev-1',
          name: 'Disabled export',
          cron: '0 * * * *',
          s3Bucket: 'exports',
          s3Region: 'us-east-1',
          s3Endpoint: 'https://s3.example.com',
          s3AccessKeyId: 'akid',
          s3SecretAccessKey: 'secret-2',
          enabled: false,
        });

        await store.update(due.id, { nextRunAt: new Date('2026-06-01T00:00:00.000Z') });
        await store.update(disabled.id, { nextRunAt: new Date('2026-06-01T00:00:00.000Z') });

        const runTime = new Date('2026-06-01T00:30:00.000Z');
        const results = await service.runDueSchedules(runTime);

        assert.equal(results.length, 1);
        assert.equal(results[0]?.scheduleId, due.id);

        const updatedDue = await store.getById(due.id);
        assert.ok(updatedDue);
        assert.deepEqual(updatedDue.lastRunAt, runTime);
        assert.equal(updatedDue.nextRunAt.toISOString(), '2026-06-01T01:00:00.000Z');

        const untouchedDisabled = await store.getById(disabled.id);
        assert.ok(untouchedDisabled);
        assert.equal(untouchedDisabled.lastRunAt, undefined);
      } finally {
        await cleanup();
      }
    });
  });
}

runScheduleStoreContractTests('InMemoryScheduleStore', async () => ({
  store: new InMemoryScheduleStore('contract-signing-secret'),
  cleanup: async () => undefined,
}));

runScheduleStoreContractTests('PostgresScheduleStore', async () => {
  const pool = createPgMemPool();
  return {
    store: new PostgresScheduleStore(pool, 'contract-signing-secret'),
    cleanup: () => pool.end(),
  };
});

describe('PostgresScheduleStore persistence and encryption', () => {
  test('schedules survive recreating the store and service, and secret is stored encrypted', async () => {
    const pool = createPgMemPool();
    try {
      const store1 = new PostgresScheduleStore(pool, 'signing-secret-v1');
      const service1 = new ScheduledExportsService(
        { findByApiId: async () => [] },
        store1,
        new HmacObjectStorageClient(),
      );

      const created = await service1.createSchedule({
        developerId: 'dev-persist',
        name: 'Survives restart',
        cron: '0 0 * * *',
        s3Bucket: 'exports',
        s3Region: 'us-east-1',
        s3Endpoint: 'https://s3.example.com',
        s3AccessKeyId: 'akid',
        s3SecretAccessKey: 'very-sensitive-plaintext-secret',
      });

      const raw = await pool.query<{ s3_secret_access_key: string }>(
        'SELECT s3_secret_access_key FROM export_schedules WHERE id = $1',
        [created.id],
      );
      const storedCiphertext = raw.rows[0]?.s3_secret_access_key ?? '';
      assert.ok(storedCiphertext.startsWith('v1.'));
      assert.notEqual(storedCiphertext, 'very-sensitive-plaintext-secret');
      assert.equal(storedCiphertext.includes('very-sensitive-plaintext-secret'), false);

      // Simulate restart with a new store and service instance over the same DB pool.
      const store2 = new PostgresScheduleStore(pool, 'signing-secret-v1');
      const service2 = new ScheduledExportsService(
        { findByApiId: async () => [] },
        store2,
        new HmacObjectStorageClient(),
      );

      const listed = await service2.listSchedulesForDeveloper('dev-persist');
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
      assert.equal(listed[0]?.s3SecretAccessKey, '[REDACTED]');

      // Decrypting with a different signing secret must fail.
      const wrongKeyStore = new PostgresScheduleStore(pool, 'different-signing-secret');
      await assert.rejects(
        () => wrongKeyStore.getById(created.id),
        /unsupported encrypted format/i,
      );
    } finally {
      await pool.end();
    }
  });
});
