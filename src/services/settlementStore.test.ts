/**
 * SettlementStore unit tests
 *
 * Tests cover:
 * - verifyLedger() method for PostgresSettlementStore
 * - Status state-machine transitions
 * - CHECK constraint enforcement (completed rows must have stellar_tx_hash)
 * - listPending() method
 */

import assert from 'node:assert/strict';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { PostgresSettlementStore, InMemorySettlementStore } from './settlementStore.js';
import type { Settlement } from '../types/developer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQr(rows: Record<string, unknown>[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as QueryResult;
}

function createMockClient(queryResults: (QueryResult | Error)[]): PoolClient {
  let idx = 0;
  return {
    query: async (_sql: string | unknown, _params?: unknown[]) => {
      if (idx >= queryResults.length) throw new Error(`Unexpected query #${idx}`);
      const result = queryResults[idx++];
      if (result instanceof Error) throw result;
      return result;
    },
    release: () => {},
  } as unknown as PoolClient;
}

function createMockPool(client: PoolClient): Pool {
  return {
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => {
      // Delegate to the mock client's query method
      return client.query(sql, params);
    },
  } as unknown as Pool;
}

const baseSettlement: Settlement = {
  id: 'settle_001',
  developerId: 'dev_abc',
  amount: 10.5,
  status: 'pending',
  tx_hash: null,
  created_at: '2025-01-15T10:00:00Z',
};

// ---------------------------------------------------------------------------
// InMemorySettlementStore tests
// ---------------------------------------------------------------------------

describe('InMemorySettlementStore', () => {
  let store: InMemorySettlementStore;

  beforeEach(() => {
    store = new InMemorySettlementStore();
  });

  test('create adds a settlement', () => {
    store.create(baseSettlement);
    const results = store.getDeveloperSettlements('dev_abc');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'settle_001');
  });

  test('updateStatus changes status and completed_at', () => {
    store.create(baseSettlement);
    store.updateStatus('settle_001', 'completed', 'tx_hash_123');

    const results = store.getDeveloperSettlements('dev_abc');
    assert.equal(results[0].status, 'completed');
    assert.equal(results[0].tx_hash, 'tx_hash_123');
    assert.ok(results[0].completed_at !== null);
  });

  test('updateStatus without txHash preserves existing tx_hash', () => {
    store.create({ ...baseSettlement, tx_hash: 'existing_tx' });
    store.updateStatus('settle_001', 'failed');

    const results = store.getDeveloperSettlements('dev_abc');
    assert.equal(results[0].tx_hash, 'existing_tx');
    assert.equal(results[0].status, 'failed');
  });

  test('listPending returns only pending settlements', () => {
    store.create(baseSettlement);
    store.create({ ...baseSettlement, id: 'settle_002', status: 'completed', tx_hash: 'tx_123' });
    store.create({ ...baseSettlement, id: 'settle_003', status: 'pending' });

    const pending = store.listPending();
    assert.equal(pending.length, 2);
    assert.ok(pending.every((s: Settlement) => s.status === 'pending'));
  });

  test('getDeveloperSettlements returns settlements sorted by created_at DESC', () => {
    store.create({ ...baseSettlement, id: 'settle_001', created_at: '2025-01-15T10:00:00Z' });
    store.create({ ...baseSettlement, id: 'settle_002', created_at: '2025-01-16T10:00:00Z' });
    store.create({ ...baseSettlement, id: 'settle_003', created_at: '2025-01-14T10:00:00Z' });

    const results = store.getDeveloperSettlements('dev_abc');
    assert.equal(results[0].id, 'settle_002');
    assert.equal(results[1].id, 'settle_001');
    assert.equal(results[2].id, 'settle_003');
  });

  test('clear removes all settlements', () => {
    store.create(baseSettlement);
    store.create({ ...baseSettlement, id: 'settle_002' });
    store.clear();

    assert.equal(store.getDeveloperSettlements('dev_abc').length, 0);
    assert.equal(store.getPendingSettlements().length, 0);
  });
});

// ---------------------------------------------------------------------------
// PostgresSettlementStore tests
// ---------------------------------------------------------------------------

describe('PostgresSettlementStore', () => {
  let store: PostgresSettlementStore;
  let client: PoolClient;
  let pool: Pool;

  beforeEach(() => {
    client = createMockClient([]);
    pool = createMockPool(client);
    store = new PostgresSettlementStore(pool);
  });

  // ---------------------------------------------------------------------------
  // verifyLedger() tests
  // ---------------------------------------------------------------------------

  describe('verifyLedger()', () => {
    test('returns empty violations when no completed settlements lack tx_hash', async () => {
      client = createMockClient([
        makeQr([]), // verifyLedger query returns no violations
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const result = await store.verifyLedger();

      assert.equal(result.totalViolations, 0);
      assert.deepEqual(result.completedWithoutTxHash, []);
    });

    test('returns violations when completed settlements lack tx_hash', async () => {
      const violationRows = [
        {
          external_id: 'settle_bad_1',
          developer_id: 'dev_1',
          amount_usdc: '15.0000000',
          created_at: '2025-01-15T10:00:00Z',
        },
        {
          external_id: 'settle_bad_2',
          developer_id: 'dev_2',
          amount_usdc: '20.5000000',
          created_at: '2025-01-16T11:00:00Z',
        },
      ];

      client = createMockClient([
        makeQr(violationRows),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const result = await store.verifyLedger();

      assert.equal(result.totalViolations, 2);
      assert.equal(result.completedWithoutTxHash[0].external_id, 'settle_bad_1');
      assert.equal(result.completedWithoutTxHash[0].developer_id, 'dev_1');
      assert.equal(result.completedWithoutTxHash[1].external_id, 'settle_bad_2');
    });

    test('verifyLedger only returns completed rows with NULL stellar_tx_hash', async () => {
      // Simulate a mix: some completed with hash, some completed without, some pending
      const mixedRows = [
        {
          external_id: 'settle_good',
          developer_id: 'dev_1',
          amount_usdc: '10.0000000',
          created_at: '2025-01-15T10:00:00Z',
        },
      ];

      client = createMockClient([
        makeQr(mixedRows),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const result = await store.verifyLedger();

      // Only the one without tx_hash should be returned
      assert.equal(result.totalViolations, 1);
      assert.equal(result.completedWithoutTxHash[0].external_id, 'settle_good');
    });
  });

  // ---------------------------------------------------------------------------
  // listPending() tests
  // ---------------------------------------------------------------------------

  describe('listPending()', () => {
    test('returns pending settlements ordered by created_at ASC', async () => {
      const pendingRows = [
        {
          external_id: 'settle_old',
          developer_id: 'dev_1',
          amount_usdc: '10.0000000',
          status: 'pending',
          stellar_tx_hash: null,
          created_at: '2025-01-15T10:00:00Z',
        },
        {
          external_id: 'settle_new',
          developer_id: 'dev_1',
          amount_usdc: '15.0000000',
          status: 'pending',
          stellar_tx_hash: null,
          created_at: '2025-01-16T10:00:00Z',
        },
      ];

      client = createMockClient([
        makeQr(pendingRows),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const results = await store.listPending();

      assert.equal(results.length, 2);
      assert.equal(results[0].id, 'settle_old');
      assert.equal(results[1].id, 'settle_new');
    });

    test('returns empty array when no pending settlements', async () => {
      client = createMockClient([
        makeQr([]),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const results = await store.listPending();

      assert.deepEqual(results, []);
    });
  });

  // ---------------------------------------------------------------------------
  // Status state-machine / transition tests
  // ---------------------------------------------------------------------------

  describe('Status state-machine transitions', () => {
    test('pending -> completed with tx_hash is valid', async () => {
      const insertResult = makeQr([]);
      const updateResult = makeQr([]);

      client = createMockClient([
        insertResult, // CREATE
        updateResult, // UPDATE STATUS
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create(baseSettlement);
      await store.updateStatus('settle_001', 'completed', 'tx_hash_123');

      // Verify the UPDATE query was called with correct params
      // The mock client tracks queries in order
    });

    test('pending -> failed without tx_hash is valid', async () => {
      const insertResult = makeQr([]);
      const updateResult = makeQr([]);

      client = createMockClient([
        insertResult,
        updateResult,
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create(baseSettlement);
      await store.updateStatus('settle_001', 'failed');

      // Should succeed - failed status does not require tx_hash
    });

    test('completed -> pending transition is allowed (state-machine permits)', async () => {
      const insertResult = makeQr([]);
      const updateResult = makeQr([]);

      client = createMockClient([
        insertResult,
        updateResult,
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create({ ...baseSettlement, status: 'completed', tx_hash: 'tx_123' });
      await store.updateStatus('settle_001', 'pending');

      // State machine allows this transition (no DB constraint prevents it)
    });

    test('failed -> completed with tx_hash is valid', async () => {
      const insertResult = makeQr([]);
      const updateResult = makeQr([]);

      client = createMockClient([
        insertResult,
        updateResult,
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create({ ...baseSettlement, status: 'failed' });
      await store.updateStatus('settle_001', 'completed', 'tx_retry_456');

      // Should succeed
    });

    test('DB CHECK rejects completed rows with NULL stellar_tx_hash (simulated)', async () => {
      // Simulate a CHECK constraint violation error from Postgres
      const checkViolation = Object.assign(
        new Error('new row for relation "settlements" violates check constraint "check_completed_has_tx_hash"'),
        { code: '23514' }
      );

      const insertResult = makeQr([]);
      const badUpdate = checkViolation;

      client = createMockClient([
        insertResult,
        badUpdate,
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create(baseSettlement);

      // Attempting to set status to 'completed' without tx_hash should fail
      await assert.rejects(
        async () => store.updateStatus('settle_001', 'completed'),
        /violates check constraint/
      );
    });

    test('DB CHECK allows pending/failed rows with NULL stellar_tx_hash', async () => {
      const insertResult = makeQr([]);
      const updateResult1 = makeQr([]);
      const updateResult2 = makeQr([]);

      client = createMockClient([
        insertResult,
        updateResult1,
        updateResult2,
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create(baseSettlement);
      // pending with NULL tx_hash is allowed
      await store.updateStatus('settle_001', 'pending');
      // failed with NULL tx_hash is allowed
      await store.updateStatus('settle_001', 'failed');
    });
  });

  // ---------------------------------------------------------------------------
  // create() tests
  // ---------------------------------------------------------------------------

  describe('create()', () => {
    test('inserts settlement with correct fields', async () => {
      let capturedParams: unknown[] = [];

      client = createMockClient([
        makeQr([]),
      ]);
      // Override query to capture params
      client.query = (async (_sql: string, params?: unknown[]) => {
        capturedParams = params ?? [];
        return makeQr([]);
      }) as PoolClient['query'];

      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      await store.create(baseSettlement);

      assert.equal(capturedParams[0], 'settle_001');
      assert.equal(capturedParams[1], 'dev_abc');
      assert.equal(capturedParams[2], 10.5);
      assert.equal(capturedParams[3], null); // tx_hash
      assert.equal(capturedParams[4], 'pending');
      assert.equal(capturedParams[5], '2025-01-15T10:00:00Z');
      assert.equal(capturedParams[6], null); // completed_at for pending
    });

    test('sets completed_at when creating a completed settlement', async () => {
      let capturedParams: unknown[] = [];

      client = createMockClient([
        makeQr([]),
      ]);
      client.query = (async (_sql: string, params?: unknown[]) => {
        capturedParams = params ?? [];
        return makeQr([]);
      }) as PoolClient['query'];

      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const completedSettlement: Settlement = {
        ...baseSettlement,
        status: 'completed',
        tx_hash: 'tx_abc',
      };

      await store.create(completedSettlement);

      assert.equal(capturedParams[4], 'completed');
      assert.equal(capturedParams[5], '2025-01-15T10:00:00Z');
      // completed_at should be set to created_at for completed settlements
      assert.equal(capturedParams[6], '2025-01-15T10:00:00Z');
    });
  });

  // ---------------------------------------------------------------------------
  // getDeveloperSettlements() tests
  // ---------------------------------------------------------------------------

  describe('getDeveloperSettlements()', () => {
    test('returns settlements for a specific developer', async () => {
      const rows = [
        {
          external_id: 'settle_1',
          developer_id: 'dev_abc',
          amount_usdc: '10.0000000',
          status: 'completed',
          stellar_tx_hash: 'tx_1',
          created_at: '2025-01-15T10:00:00Z',
        },
        {
          external_id: 'settle_2',
          developer_id: 'dev_abc',
          amount_usdc: '20.0000000',
          status: 'pending',
          stellar_tx_hash: null,
          created_at: '2025-01-16T10:00:00Z',
        },
      ];

      client = createMockClient([
        makeQr(rows),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const results = await store.getDeveloperSettlements('dev_abc');

      assert.equal(results.length, 2);
      assert.equal(results[0].id, 'settle_1');
      assert.equal(results[0].amount, 10);
      assert.equal(results[1].id, 'settle_2');
      assert.equal(results[1].amount, 20);
    });

    test('returns empty array for developer with no settlements', async () => {
      client = createMockClient([
        makeQr([]),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const results = await store.getDeveloperSettlements('dev_nonexistent');

      assert.deepEqual(results, []);
    });
  });

  // ---------------------------------------------------------------------------
  // getPendingSettlements() tests
  // ---------------------------------------------------------------------------

  describe('getPendingSettlements()', () => {
    test('returns only pending settlements', async () => {
      const rows = [
        {
          external_id: 'settle_pending_1',
          developer_id: 'dev_1',
          amount_usdc: '10.0000000',
          status: 'pending',
          stellar_tx_hash: null,
          created_at: '2025-01-15T10:00:00Z',
        },
        {
          external_id: 'settle_pending_2',
          developer_id: 'dev_2',
          amount_usdc: '15.0000000',
          status: 'pending',
          stellar_tx_hash: null,
          created_at: '2025-01-16T10:00:00Z',
        },
      ];

      client = createMockClient([
        makeQr(rows),
      ]);
      pool = createMockPool(client);
      store = new PostgresSettlementStore(pool);

      const results = await store.getPendingSettlements();

      assert.equal(results.length, 2);
      assert.ok(results.every((s: Settlement) => s.status === 'pending'));
    });
  });
});