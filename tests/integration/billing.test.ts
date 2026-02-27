/**
 * Billing Service Integration Tests
 * 
 * Tests billing idempotency with real database integration
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createTestDb } from '../helpers/db.js';
import { BillingService, type BillingDeductRequest, type SorobanClient } from '../../src/services/billing.js';

// Mock Soroban client for integration tests
class MockSorobanClient implements SorobanClient {
  private callCount = 0;
  private shouldFail = false;

  async deductBalance(userId: string, amount: string): Promise<string> {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error('Soroban network error');
    }
    return `tx_${userId}_${amount}_${this.callCount}`;
  }

  getCallCount(): number {
    return this.callCount;
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  reset(): void {
    this.callCount = 0;
    this.shouldFail = false;
  }
}

describe('BillingService - Integration Tests', () => {
  test('successfully processes new billing request', async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();

    try {
      // Create usage_events table
      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          api_id VARCHAR(255) NOT NULL,
          endpoint_id VARCHAR(255) NOT NULL,
          api_key_id VARCHAR(255) NOT NULL,
          amount_usdc NUMERIC NOT NULL,
          request_id VARCHAR(255) NOT NULL UNIQUE,
          stellar_tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      const billingService = new BillingService(testDb.pool, sorobanClient);

      const request: BillingDeductRequest = {
        requestId: 'req_integration_001',
        userId: 'user_alice',
        apiId: 'api_weather',
        endpointId: 'endpoint_forecast',
        apiKeyId: 'key_abc123',
        amountUsdc: '0.05',
      };

      const result = await billingService.deduct(request);

      assert.equal(result.success, true);
      assert.equal(result.alreadyProcessed, false);
      assert.ok(result.usageEventId);
      assert.ok(result.stellarTxHash);
      assert.equal(sorobanClient.getCallCount(), 1);

      // Verify record in database
      const dbResult = await testDb.pool.query(
        'SELECT * FROM usage_events WHERE request_id = $1',
        [request.requestId]
      );

      assert.equal(dbResult.rows.length, 1);
      assert.equal(dbResult.rows[0].user_id, 'user_alice');
      assert.equal(dbResult.rows[0].api_id, 'api_weather');
      assert.equal(dbResult.rows[0].amount_usdc, '0.0500000');
      assert.ok(dbResult.rows[0].stellar_tx_hash);
    } finally {
      await testDb.end();
    }
  });

  test('prevents double charge on duplicate request_id', async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();

    try {
      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          api_id VARCHAR(255) NOT NULL,
          endpoint_id VARCHAR(255) NOT NULL,
          api_key_id VARCHAR(255) NOT NULL,
          amount_usdc NUMERIC NOT NULL,
          request_id VARCHAR(255) NOT NULL UNIQUE,
          stellar_tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      const billingService = new BillingService(testDb.pool, sorobanClient);

      const request: BillingDeductRequest = {
        requestId: 'req_duplicate_test',
        userId: 'user_bob',
        apiId: 'api_payment',
        endpointId: 'endpoint_charge',
        apiKeyId: 'key_xyz789',
        amountUsdc: '1.00',
      };

      // First request - should process normally
      const result1 = await billingService.deduct(request);
      assert.equal(result1.success, true);
      assert.equal(result1.alreadyProcessed, false);
      assert.equal(sorobanClient.getCallCount(), 1);

      // Second request with same request_id - should return existing
      const result2 = await billingService.deduct(request);
      assert.equal(result2.success, true);
      assert.equal(result2.alreadyProcessed, true);
      assert.equal(result2.usageEventId, result1.usageEventId);
      assert.equal(result2.stellarTxHash, result1.stellarTxHash);
      // Soroban should NOT be called again
      assert.equal(sorobanClient.getCallCount(), 1);

      // Verify only one record in database
      const dbResult = await testDb.pool.query(
        'SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1',
        [request.requestId]
      );
      assert.equal(dbResult.rows[0].count, '1');
    } finally {
      await testDb.end();
    }
  });

  test('rolls back transaction when Soroban fails', async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();
    sorobanClient.setShouldFail(true);

    try {
      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          api_id VARCHAR(255) NOT NULL,
          endpoint_id VARCHAR(255) NOT NULL,
          api_key_id VARCHAR(255) NOT NULL,
          amount_usdc NUMERIC NOT NULL,
          request_id VARCHAR(255) NOT NULL UNIQUE,
          stellar_tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      const billingService = new BillingService(testDb.pool, sorobanClient);

      const request: BillingDeductRequest = {
        requestId: 'req_rollback_test',
        userId: 'user_charlie',
        apiId: 'api_data',
        endpointId: 'endpoint_query',
        apiKeyId: 'key_fail123',
        amountUsdc: '0.10',
      };

      const result = await billingService.deduct(request);

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Soroban'));

      // Verify NO record in database (transaction rolled back)
      const dbResult = await testDb.pool.query(
        'SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1',
        [request.requestId]
      );
      assert.equal(dbResult.rows[0].count, '0');
    } finally {
      await testDb.end();
    }
  });

  test('handles concurrent requests with same request_id', async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();

    try {
      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          api_id VARCHAR(255) NOT NULL,
          endpoint_id VARCHAR(255) NOT NULL,
          api_key_id VARCHAR(255) NOT NULL,
          amount_usdc NUMERIC NOT NULL,
          request_id VARCHAR(255) NOT NULL UNIQUE,
          stellar_tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      const billingService = new BillingService(testDb.pool, sorobanClient);

      const request: BillingDeductRequest = {
        requestId: 'req_concurrent_test',
        userId: 'user_david',
        apiId: 'api_concurrent',
        endpointId: 'endpoint_test',
        apiKeyId: 'key_concurrent',
        amountUsdc: '0.25',
      };

      // Simulate concurrent requests
      const [result1, result2, result3] = await Promise.all([
        billingService.deduct(request),
        billingService.deduct(request),
        billingService.deduct(request),
      ]);

      // All should succeed
      assert.equal(result1.success, true);
      assert.equal(result2.success, true);
      assert.equal(result3.success, true);

      // At least one should be marked as already processed
      const processedCount = [result1, result2, result3].filter(
        (r) => r.alreadyProcessed
      ).length;
      assert.ok(processedCount >= 1);

      // All should have the same usage event ID
      assert.equal(result1.usageEventId, result2.usageEventId);
      assert.equal(result2.usageEventId, result3.usageEventId);

      // Soroban should only be called once
      assert.equal(sorobanClient.getCallCount(), 1);

      // Verify only one record in database
      const dbResult = await testDb.pool.query(
        'SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1',
        [request.requestId]
      );
      assert.equal(dbResult.rows[0].count, '1');
    } finally {
      await testDb.end();
    }
  });

  test('getByRequestId returns existing usage event', async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();

    try {
      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          api_id VARCHAR(255) NOT NULL,
          endpoint_id VARCHAR(255) NOT NULL,
          api_key_id VARCHAR(255) NOT NULL,
          amount_usdc NUMERIC NOT NULL,
          request_id VARCHAR(255) NOT NULL UNIQUE,
          stellar_tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      const billingService = new BillingService(testDb.pool, sorobanClient);

      const request: BillingDeductRequest = {
        requestId: 'req_lookup_test',
        userId: 'user_eve',
        apiId: 'api_lookup',
        endpointId: 'endpoint_get',
        apiKeyId: 'key_lookup',
        amountUsdc: '0.15',
      };

      // Create usage event
      const deductResult = await billingService.deduct(request);
      assert.equal(deductResult.success, true);

      // Lookup by request ID
      const lookupResult = await billingService.getByRequestId(request.requestId);
      assert.ok(lookupResult !== null);
      assert.equal(lookupResult.usageEventId, deductResult.usageEventId);
      assert.equal(lookupResult.stellarTxHash, deductResult.stellarTxHash);
      assert.equal(lookupResult.alreadyProcessed, true);
    } finally {
      await testDb.end();
    }
  });

  test('getByRequestId returns null for non-existent request', async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();

    try {
      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          api_id VARCHAR(255) NOT NULL,
          endpoint_id VARCHAR(255) NOT NULL,
          api_key_id VARCHAR(255) NOT NULL,
          amount_usdc NUMERIC NOT NULL,
          request_id VARCHAR(255) NOT NULL UNIQUE,
          stellar_tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      const billingService = new BillingService(testDb.pool, sorobanClient);

      const result = await billingService.getByRequestId('req_nonexistent');
      assert.equal(result, null);
    } finally {
      await testDb.end();
    }
  });
});
