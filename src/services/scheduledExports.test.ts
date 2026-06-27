import assert from 'node:assert/strict';
import { DataType, newDb } from 'pg-mem';
import { PgUsageEventsRepository, type UsageEventsRepositoryQueryable } from '../repositories/usageEventsRepository.pg.js';
import type { BillingUsageEvent } from '../repositories/usageEventsRepository.pg.js';
import {
  HmacObjectStorageClient,
  InMemoryScheduleStore,
  ScheduledExportsService,
  computeNextRunAt,
  createScheduledExportsWorker,
  eventsToCsv,
  eventsToJson,
} from './scheduledExports.js';

async function listAllEvents(pool: any): Promise<BillingUsageEvent[]> {
  const result = await pool.query(`SELECT id, user_id, api_id, endpoint_id, api_key_id, developer_id, amount_usdc, request_id, stellar_tx_hash, created_at FROM usage_events ORDER BY created_at ASC`);
  return result.rows.map((row: any) => ({ id: String(row.id), userId: row.user_id, apiId: row.api_id, endpointId: row.endpoint_id, apiKeyId: row.api_key_id, developerId: row.developer_id, amount: BigInt(row.amount_usdc), requestId: row.request_id, stellarTxHash: row.stellar_tx_hash, createdAt: new Date(row.created_at) }));
}

function createUsageRepository() {
  const db = newDb();
  db.public.registerFunction({ name: 'now', returns: DataType.timestamp, implementation: () => new Date('2026-03-01T00:00:00.000Z') });
  db.public.none(`
    CREATE TABLE usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      api_id VARCHAR(255) NOT NULL,
      endpoint_id VARCHAR(255) NOT NULL,
      api_key_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL DEFAULT '',
      amount_usdc NUMERIC(20, 0) NOT NULL,
      request_id VARCHAR(255) NOT NULL,
      stellar_tx_hash VARCHAR(64),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (request_id, developer_id)
    );
    CREATE INDEX idx_usage_events_api_created ON usage_events(api_id, created_at);
    CREATE INDEX idx_usage_events_user_created ON usage_events(user_id, created_at);
  `);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return { repository: new PgUsageEventsRepository(pool as UsageEventsRepositoryQueryable), pool };
}

test('computeNextRunAt returns a future matching minute/hour', () => {
  const next = computeNextRunAt('15 10 * * *', new Date('2026-06-01T10:10:00.000Z'));
  assert.equal(next.toISOString(), '2026-06-01T10:15:00.000Z');
});

test('csv and json serializers include usage event fields', async () => {
  const { repository, pool } = createUsageRepository();
  try {
    const event = await repository.create({ userId: 'u1', apiId: 'api-1', endpointId: 'ep-1', apiKeyId: 'key-1', developerId: 'dev-1', amount: 15n, requestId: 'req-1', createdAt: new Date('2026-06-01T00:00:00.000Z') });
    const csv = eventsToCsv([event]);
    const json = eventsToJson([event]);
    assert.match(csv, /id,userId,apiId/);
    assert.match(csv, /req-1/);
    assert.match(json, /"amount": "15"/);
  } finally {
    await pool.end();
  }
});

test('service persists schedule, runs due job, uploads csv+json, and returns signed urls', async () => {
  const { repository, pool } = createUsageRepository();
  try {
    await repository.create({ userId: 'u1', apiId: 'api-1', endpointId: 'ep-1', apiKeyId: 'key-1', developerId: 'dev-1', amount: 15n, requestId: 'req-1', createdAt: new Date('2026-06-01T00:00:00.000Z') });
    await repository.create({ userId: 'u2', apiId: 'api-2', endpointId: 'ep-2', apiKeyId: 'key-2', developerId: 'dev-2', amount: 30n, requestId: 'req-2', createdAt: new Date('2026-06-01T00:05:00.000Z') });

    const store = new InMemoryScheduleStore();
    const objectStorage = new HmacObjectStorageClient();
    const service = new ScheduledExportsService({ findByApiId: async () => listAllEvents(pool) }, store, objectStorage);

    const created = await service.createSchedule({
      developerId: 'dev-1',
      name: 'Daily export',
      cron: '* * * * *',
      s3Bucket: 'exports',
      s3Region: 'us-east-1',
      s3Endpoint: 'https://s3.example.com',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'secret',
      s3PathPrefix: 'daily',
      enabled: true,
    });

    await store.update(created.id, { nextRunAt: new Date('2026-06-01T00:00:00.000Z') });
    const [result] = await service.runDueSchedules(new Date('2026-06-01T01:00:00.000Z'));

    assert.equal(result?.rowCount, 1);
    assert.equal(objectStorage.uploads.length, 2);
    assert.match(result!.objectKeys.csv, /daily\/usage-events-/);
    assert.match(result!.signedUrls.csv, /signature=/);
    assert.match(result!.signedUrls.json, /expires=/);

    const listed = await service.listSchedulesForDeveloper('dev-1');
    assert.equal(listed[0]?.s3SecretAccessKey, '[REDACTED]');
  } finally {
    await pool.end();
  }
});

test('worker starts, processes due schedules, and idles cleanly', async () => {
  const { repository, pool } = createUsageRepository();
  try {
    await repository.create({ userId: 'u1', apiId: 'api-1', endpointId: 'ep-1', apiKeyId: 'key-1', developerId: 'dev-1', amount: 15n, requestId: 'req-1', createdAt: new Date('2026-06-01T00:00:00.000Z') });
    const store = new InMemoryScheduleStore();
    const objectStorage = new HmacObjectStorageClient();
    const service = new ScheduledExportsService({ findByApiId: async () => listAllEvents(pool) }, store, objectStorage);
    const schedule = await service.createSchedule({ developerId: 'dev-1', name: 'Minute export', cron: '* * * * *', s3Bucket: 'exports', s3Region: 'us-east-1', s3Endpoint: 'https://s3.example.com', s3AccessKeyId: 'akid', s3SecretAccessKey: 'secret', enabled: true });
    await store.update(schedule.id, { nextRunAt: new Date(0) });

    const worker = createScheduledExportsWorker(service, { intervalMs: 25 });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    worker.stop();
    await worker.awaitIdle();

    assert.equal(objectStorage.uploads.length >= 2, true);
  } finally {
    await pool.end();
  }
});
