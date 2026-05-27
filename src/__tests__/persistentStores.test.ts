import express from 'express';
import request from 'supertest';
import { DataType, newDb } from 'pg-mem';
import { createDeveloperRouter } from '../routes/developerRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createPostgresSettlementStore } from '../services/settlementStore.js';
import { createPostgresUsageStore } from '../services/usageStore.js';

function createPersistentStoreHarness() {
  const db = newDb();

  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date('2026-03-01T00:00:00.000Z'),
  });

  db.public.none(`
    CREATE TABLE usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      api_id VARCHAR(255) NOT NULL,
      endpoint_id VARCHAR(255) NOT NULL,
      api_key_id VARCHAR(255) NOT NULL,
      api_key VARCHAR(255),
      amount_usdc NUMERIC NOT NULL,
      request_id VARCHAR(255) NOT NULL UNIQUE,
      status_code INTEGER NOT NULL DEFAULT 200,
      stellar_tx_hash VARCHAR(64),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE settlements (
      id BIGSERIAL PRIMARY KEY,
      external_id VARCHAR(255) NOT NULL UNIQUE,
      developer_id VARCHAR(255) NOT NULL,
      amount_usdc NUMERIC NOT NULL,
      stellar_tx_hash VARCHAR(64),
      status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP
    );

    CREATE TABLE revenue_ledger (
      id BIGSERIAL PRIMARY KEY,
      api_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL,
      amount_usdc NUMERIC NOT NULL,
      usage_event_id BIGINT NOT NULL UNIQUE REFERENCES usage_events(id),
      settlement_id BIGINT REFERENCES settlements(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    pool,
    settlementStore: createPostgresSettlementStore(pool),
    usageStore: createPostgresUsageStore(pool),
  };
}

test('PostgresSettlementStore preserves ordering and status updates', async () => {
  const { pool, settlementStore } = createPersistentStoreHarness();

  try {
    await settlementStore.create({
      id: 'stl_older',
      developerId: 'dev_1',
      amount: 10,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await settlementStore.create({
      id: 'stl_newer',
      developerId: 'dev_1',
      amount: 25,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-01-02T00:00:00.000Z',
    });

    await settlementStore.updateStatus('stl_newer', 'completed', 'stellar-tx-1');

    const settlements = await settlementStore.getDeveloperSettlements('dev_1');

    expect(settlements.map((settlement) => settlement.id)).toEqual(['stl_newer', 'stl_older']);
    expect(settlements[0]).toMatchObject({
      status: 'completed',
      tx_hash: 'stellar-tx-1',
      amount: 25,
    });
  } finally {
    await pool.end();
  }
});

test('PostgresUsageStore records idempotently and marks events as settled', async () => {
  const { pool, settlementStore, usageStore } = createPersistentStoreHarness();

  try {
    const firstInsert = await usageStore.record({
      id: 'ignored-in-pg-store',
      requestId: 'req-1',
      apiKey: 'key-1',
      apiKeyId: 'key-1',
      apiId: 'api-1',
      endpointId: 'endpoint-1',
      userId: 'dev_1',
      amountUsdc: 4.25,
      statusCode: 200,
      timestamp: '2026-02-01T10:00:00.000Z',
    });

    const duplicateInsert = await usageStore.record({
      id: 'another-ignored-id',
      requestId: 'req-1',
      apiKey: 'key-1',
      apiKeyId: 'key-1',
      apiId: 'api-1',
      endpointId: 'endpoint-1',
      userId: 'dev_1',
      amountUsdc: 999,
      statusCode: 500,
      timestamp: '2026-02-02T10:00:00.000Z',
    });

    const events = await usageStore.getEvents('key-1');
    expect(firstInsert).toBe(true);
    expect(duplicateInsert).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: 'req-1',
      amountUsdc: 4.25,
      statusCode: 200,
      apiKey: 'key-1',
      settlementId: undefined,
    });

    await settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: 4.25,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-02-03T10:00:00.000Z',
    });

    await usageStore.markAsSettled([events[0]!.id], 'stl_1');

    const unsettled = await usageStore.getUnsettledEvents();
    const settledEvents = await usageStore.getEvents('key-1');

    expect(unsettled).toEqual([]);
    expect(settledEvents[0]?.settlementId).toBe('stl_1');
  } finally {
    await pool.end();
  }
});

test('persistent stores survive new instances and keep developer revenue available after restart', async () => {
  const harness = createPersistentStoreHarness();

  try {
    await harness.settlementStore.create({
      id: 'stl_completed',
      developerId: 'dev_restart',
      amount: 8,
      status: 'completed',
      tx_hash: 'stellar-complete',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await harness.settlementStore.create({
      id: 'stl_pending',
      developerId: 'dev_restart',
      amount: 5,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-02-02T00:00:00.000Z',
    });
    await harness.usageStore.record({
      id: 'restart-event',
      requestId: 'req-restart',
      apiKey: 'key-restart',
      apiKeyId: 'key-restart',
      apiId: 'api-restart',
      endpointId: 'endpoint-restart',
      userId: 'dev_restart',
      amountUsdc: 3,
      statusCode: 200,
      timestamp: '2026-02-03T00:00:00.000Z',
    });

    const app = express();
    app.use(express.json());
    app.use('/api/developers', createDeveloperRouter({
      settlementStore: createPostgresSettlementStore(harness.pool),
      usageStore: createPostgresUsageStore(harness.pool),
    }));
    app.use(errorHandler);

    const res = await request(app)
      .get('/api/developers/revenue')
      .set('x-user-id', 'dev_restart');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      total_earned: 16,
      pending: 5,
      available_to_withdraw: 3,
    });
    expect(res.body.settlements.map((settlement: { id: string }) => settlement.id)).toEqual([
      'stl_pending',
      'stl_completed',
    ]);
  } finally {
    await harness.pool.end();
  }
});
