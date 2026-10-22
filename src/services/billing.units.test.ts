import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { BillingService, type SorobanClient } from './billing.js';
import { formatContractUnitsToUsdc } from '../lib/usdcUnits.js';
import { createUsageEventsTable } from '../../tests/helpers/db.js';

describe('BillingService Unit Tests (SQL-level with pg-mem)', () => {
  let pool: Pool;
  let mockSorobanClient: SorobanClient;
  let billingService: BillingService;

  beforeEach(async () => {
    const db = newDb();

    db.public.registerFunction({
      name: 'now',
      returns: DataType.timestamp,
      implementation: () => new Date('2026-03-01T00:00:00.000Z'),
    });


    const pgAdapter = db.adapters.createPg();
    pool = new pgAdapter.Pool() as unknown as Pool;
    await createUsageEventsTable(pool);

    mockSorobanClient = {
      getBalance: async () => ({ balance: '100000000000' }), // plenty of balance in contract units
      deductBalance: async () => ({ txHash: 'stellar_tx_hash_mock_123' }),
    };

    billingService = new BillingService(pool, mockSorobanClient);
  });

  afterEach(async () => {
    await pool.end();
  });

  describe('Scenario 1: Deduct fractional amountUsdc "0.0012345"', () => {
    it('stores 12345 in the database row and echoes successful deduction', async () => {
      const result = await billingService.deduct({
        requestId: 'req-frac-1',
        userId: 'user-1',
        apiId: 'api-1',
        endpointId: 'ep-1',
        apiKeyId: 'key-1',
        amountUsdc: '0.0012345',
      });

      expect(result.success).toBe(true);
      expect(result.deductionApplied).toBe(true);

      const dbRes = await pool.query<{ amount_usdc: string }>(
        'SELECT amount_usdc FROM usage_events WHERE request_id = $1',
        ['req-frac-1'],
      );

      expect(dbRes.rows).toHaveLength(1);
      expect(String(dbRes.rows[0].amount_usdc).split('.')[0]).toBe('12345');
    });
  });

  describe('Scenario 2: Deduct amountUsdc "1.5" (Regression Proof against NUMERIC(20,0) rounding)', () => {
    it('stores 15000000, not 2', async () => {
      const result = await billingService.deduct({
        requestId: 'req-frac-2',
        userId: 'user-1',
        apiId: 'api-1',
        endpointId: 'ep-1',
        apiKeyId: 'key-1',
        amountUsdc: '1.5',
      });

      expect(result.success).toBe(true);

      const dbRes = await pool.query<{ amount_usdc: string }>(
        'SELECT amount_usdc FROM usage_events WHERE request_id = $1',
        ['req-frac-2'],
      );

      expect(dbRes.rows).toHaveLength(1);
      // Regression check: must be 15000000 contract units, NOT 2
      expect(String(dbRes.rows[0].amount_usdc).split('.')[0]).toBe('15000000');
      expect(String(dbRes.rows[0].amount_usdc).split('.')[0]).not.toBe('2');
    });
  });

  describe('Scenario 3: Bulk deduct with three fractional items', () => {
    it('stores exact units in each row and totalDeductedAmountUsdc equals the sum', async () => {
      const items = [
        {
          requestId: 'bulk-req-1',
          userId: 'user-bulk',
          apiId: 'api-1',
          endpointId: 'ep-1',
          apiKeyId: 'key-1',
          amountUsdc: '0.0012345', // 12345n units
        },
        {
          requestId: 'bulk-req-2',
          userId: 'user-bulk',
          apiId: 'api-1',
          endpointId: 'ep-2',
          apiKeyId: 'key-1',
          amountUsdc: '0.01', // 100000n units
        },
        {
          requestId: 'bulk-req-3',
          userId: 'user-bulk',
          apiId: 'api-1',
          endpointId: 'ep-3',
          apiKeyId: 'key-1',
          amountUsdc: '1.5', // 15000000n units
        },
      ];

      const expectedTotalUnits = 12345n + 100000n + 15000000n; // 15112345n
      const expectedTotalUsdc = formatContractUnitsToUsdc(expectedTotalUnits); // "1.5112345"

      const bulkResult = await billingService.deductBulk(items);

      expect(bulkResult.success).toBe(true);
      expect(bulkResult.deductedCount).toBe(3);
      expect(bulkResult.totalDeductedAmountUsdc).toBe(expectedTotalUsdc);

      const dbRes = await pool.query<{ request_id: string; amount_usdc: string }>(
        'SELECT request_id, amount_usdc FROM usage_events ORDER BY id ASC',
      );

      expect(dbRes.rows).toHaveLength(3);
      expect(String(dbRes.rows[0].amount_usdc).split('.')[0]).toBe('12345');
      expect(String(dbRes.rows[1].amount_usdc).split('.')[0]).toBe('100000');
      expect(String(dbRes.rows[2].amount_usdc).split('.')[0]).toBe('15000000');
    });
  });
});
