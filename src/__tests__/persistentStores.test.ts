import express from 'express';
import request from 'supertest';
import { DataType, newDb } from 'pg-mem';
import { createDeveloperRouter } from '../routes/developerRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import { createPostgresSettlementStore } from '../services/settlementStore.js';
import { createPostgresUsageStore } from '../services/usageStore.js';
import { PgUsageEventsRepository, type UsageEventsRepositoryQueryable } from '../repositories/usageEventsRepository.pg.js';

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
      deduction_status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE apis (
      id VARCHAR(255) PRIMARY KEY,
      developer_id VARCHAR(255) NOT NULL
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
      usage_event_id BIGINT UNIQUE REFERENCES usage_events(id),
      settlement_id BIGINT REFERENCES settlements(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reversed_at TIMESTAMP,
      reversal_of_usage_event_id BIGINT UNIQUE
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
      amount: 100000000n,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await settlementStore.create({
      id: 'stl_newer',
      developerId: 'dev_1',
      amount: 250000000n,
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
      amount: 250000000n,
    });
  } finally {
    await pool.end();
  }
});

test('PostgresUsageStore records idempotently without accruing unconfirmed revenue', async () => {
  const { pool, settlementStore, usageStore } = createPersistentStoreHarness();

  try {
    await pool.query(
      'INSERT INTO apis (id, developer_id) VALUES ($1, $2)',
      ['api-1', 'api-owner-1'],
    );

    const firstInsert = await usageStore.record({
      id: 'ignored-in-pg-store',
      requestId: 'req-1',
      apiKey: 'key-1',
      apiKeyId: 'key-1',
      apiId: 'api-1',
      endpointId: 'endpoint-1',
      userId: 'dev_1',
      amountUsdc: 42500000n,
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
      amountUsdc: 9990000000n,
      statusCode: 500,
      timestamp: '2026-02-02T10:00:00.000Z',
    });

    const unconfirmedLedger = await pool.query(
      "SELECT COUNT(*)::int AS count FROM revenue_ledger rl JOIN usage_events ue ON ue.id = rl.usage_event_id WHERE ue.request_id = 'req-1'",
    );
    expect(unconfirmedLedger.rows[0]?.count).toBe(0);

    const events = await usageStore.getEvents('key-1');
    expect(firstInsert).toBe(true);
    expect(duplicateInsert).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: 'req-1',
      amountUsdc: 42500000n,
      statusCode: 200,
      apiKey: 'key-1',
      userId: 'api-owner-1',
      settlementId: undefined,
    });

    // Simulate the revenue indexer accruing the row only after confirmation.
    await pool.query("UPDATE usage_events SET stellar_tx_hash = 'confirmed-tx', deduction_status = 'confirmed' WHERE request_id = 'req-1'");
    await pool.query(
      `INSERT INTO revenue_ledger (api_id, developer_id, amount_usdc, usage_event_id, created_at)
       SELECT ue.api_id, apis.developer_id, ue.amount_usdc, ue.id, ue.created_at
       FROM usage_events ue JOIN apis ON apis.id = ue.api_id
       WHERE ue.request_id = 'req-1'`,
    );

    await settlementStore.create({
      id: 'stl_1',
      developerId: 'dev_1',
      amount: 42500000n,
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

test('voided unsettled revenue is reversed and settled revenue receives a negative compensation', async () => {
  const { pool, settlementStore, usageStore } = createPersistentStoreHarness();
  const repository = new PgUsageEventsRepository(pool as unknown as UsageEventsRepositoryQueryable);
  try {
    await pool.query('INSERT INTO apis (id, developer_id) VALUES ($1, $2)', ['api-void', 'dev-void']);
    await usageStore.record({
      id: 'void-unsettled', requestId: 'req-void-unsettled', apiKey: 'key-void', apiKeyId: 'key-void',
      apiId: 'api-void', endpointId: 'ep-void', userId: 'consumer', amountUsdc: 7n, statusCode: 200,
      timestamp: '2026-02-01T00:00:00.000Z',
    });
    await pool.query("UPDATE usage_events SET stellar_tx_hash = 'tx-u', deduction_status = 'confirmed' WHERE request_id = 'req-void-unsettled'");
    await pool.query(
      `INSERT INTO revenue_ledger (api_id, developer_id, amount_usdc, usage_event_id, created_at)
       SELECT api_id, 'dev-void', amount_usdc, id, created_at FROM usage_events WHERE request_id = 'req-void-unsettled'`,
    );
    await pool.query("UPDATE usage_events SET deduction_status = 'voided' WHERE request_id = 'req-void-unsettled'");

    expect(await repository.reverseVoidedRevenueLedgerEvents()).toBe(1);
    const unsettledOriginal = await pool.query("SELECT amount_usdc::text, reversed_at FROM revenue_ledger WHERE usage_event_id = 1");
    expect(unsettledOriginal.rows[0]).toMatchObject({ amount_usdc: '0' });
    expect(unsettledOriginal.rows[0]?.reversed_at).toBeTruthy();
    expect(await usageStore.getUnsettledEvents()).toEqual([]);

    await usageStore.record({
      id: 'void-settled', requestId: 'req-void-settled', apiKey: 'key-void', apiKeyId: 'key-void',
      apiId: 'api-void', endpointId: 'ep-void', userId: 'consumer', amountUsdc: 9n, statusCode: 200,
      timestamp: '2026-02-02T00:00:00.000Z',
    });
    await pool.query("UPDATE usage_events SET stellar_tx_hash = 'tx-s', deduction_status = 'confirmed' WHERE request_id = 'req-void-settled'");
    await pool.query(
      `INSERT INTO revenue_ledger (api_id, developer_id, amount_usdc, usage_event_id, created_at)
       SELECT api_id, 'dev-void', amount_usdc, id, created_at FROM usage_events WHERE request_id = 'req-void-settled'`,
    );
    await settlementStore.create({
      id: 'stl-void-settled', developerId: 'dev-void', amount: 9n, status: 'completed', tx_hash: 'tx-settlement',
      created_at: '2026-02-03T00:00:00.000Z',
    });
    const settledEvent = (await usageStore.getEvents('key-void')).find((event) => event.requestId === 'req-void-settled');
    await usageStore.markAsSettled([settledEvent!.id], 'stl-void-settled');
    await pool.query("UPDATE usage_events SET deduction_status = 'voided' WHERE request_id = 'req-void-settled'");

    expect(await repository.reverseVoidedRevenueLedgerEvents()).toBe(1);
    type RevenueLedgerRow = {
      usage_event_id: string;
      amount_usdc: string;
      reversed_at: Date | null;
      reversal_of_usage_event_id: string | null;
    };
    const rows: { rows: RevenueLedgerRow[] } = await pool.query(
      `SELECT usage_event_id, amount_usdc::text, reversed_at, reversal_of_usage_event_id
       FROM revenue_ledger ORDER BY id`,
    );
    const settled = rows.rows.find((row) => String(row.usage_event_id) === String(settledEvent?.id));
    const compensation = rows.rows.find((row) => String(row.reversal_of_usage_event_id) === String(settledEvent?.id));
    expect(settled?.amount_usdc).toBe('9');
    expect(settled?.reversed_at).toBeTruthy();
    expect(compensation?.amount_usdc).toBe('-9');
    expect(await usageStore.getUnsettledEvents()).toEqual([]);
    const invariant = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM revenue_ledger rl JOIN usage_events ue ON ue.id = rl.usage_event_id
      WHERE (ue.stellar_tx_hash IS NULL OR ue.deduction_status = 'voided')
        AND rl.reversed_at IS NULL
    `);
    expect(invariant.rows[0]?.count).toBe(0);
  } finally {
    await pool.end();
  }
});

test('persistent stores survive new instances and keep developer revenue available after restart', async () => {
  const harness = createPersistentStoreHarness();

  try {
    await harness.pool.query(
      'INSERT INTO apis (id, developer_id) VALUES ($1, $2)',
      ['api-restart', 'dev_restart'],
    );

    await harness.settlementStore.create({
      id: 'stl_completed',
      developerId: 'dev_restart',
      amount: 80000000n,
      status: 'completed',
      tx_hash: 'stellar-complete',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    await harness.settlementStore.create({
      id: 'stl_pending',
      developerId: 'dev_restart',
      amount: 50000000n,
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
      amountUsdc: 30000000n,
      statusCode: 200,
      timestamp: '2026-02-03T00:00:00.000Z',
    });

    const app = express();
    app.use(express.json());
    const developerRepository: DeveloperRepository = {
      findByUserId: async () => undefined,
      getOrCreateByUserId: async () => {
        throw new Error('not used in this test');
      },
      upsertProfile: async () => {
        throw new Error('not used in this test');
      },
    };
    app.use('/api/developers', createDeveloperRouter({
      settlementStore: createPostgresSettlementStore(harness.pool),
      usageStore: createPostgresUsageStore(harness.pool),
      developerRepository,
    }));
    app.use(errorHandler);

    const res = await request(app)
      .get('/api/developers/revenue')
      .set('x-user-id', 'dev_restart');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      total_earned: 13,
      pending: 5,
      available_to_withdraw: 0,
    });
    expect(res.body.settlements.map((settlement: { id: string }) => settlement.id)).toEqual([
      'stl_pending',
      'stl_completed',
    ]);
  } finally {
    await harness.pool.end();
  }
});
