/**
 * Billing Service Integration Tests
 *
 * Tests billing idempotency with real database integration
 * Tests end-to-end settlement/invoice generation flow
 */

import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import {
  BillingService,
  type BillingDeductRequest,
  type SorobanClient,
} from "../../src/services/billing.js";
import { RevenueSettlementService } from "../../src/services/revenueSettlementService.js";
import { InMemorySettlementStore } from "../../src/services/settlementStore.js";
import { type SorobanSettlementClient } from "../../src/services/sorobanSettlement.js";
import type {
  UsageStore,
  ApiRegistry,
  UsageEvent,
  ApiRegistryEntry,
} from "../../src/types/gateway.js";
import type { SettlementStore, Settlement } from "../../src/types/developer.js";

// Mock Soroban client for integration tests
class MockSorobanClient implements SorobanClient {
  private callCount = 0;
  private shouldFail = false;
  private balance = "1000000000";

  async getBalance(): Promise<{ balance: string }> {
    return { balance: this.balance };
  }

  async deductBalance(
    userId: string,
    amount: string,
  ): Promise<{ txHash: string }> {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error("Soroban network error");
    }
    return { txHash: `tx_${userId}_${amount}_${this.callCount}` };
  }

  getCallCount(): number {
    return this.callCount;
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  setBalance(balance: string): void {
    this.balance = balance;
  }

  reset(): void {
    this.callCount = 0;
    this.shouldFail = false;
  }
}

// Mock Soroban Settlement client
class MockSorobanSettlementClient {
  private callCount = 0;
  private shouldFail = false;

  async distribute(
    developerId: string,
    amount: number,
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    this.callCount++;
    if (this.shouldFail) {
      return {
        success: false,
        error: "Settlement network error",
      };
    }
    return {
      success: true,
      txHash: `settlement_tx_${developerId}_${amount}_${this.callCount}`,
    };
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

// Mock Usage Store for settlement tests
class MockUsageStore implements UsageStore {
  private events: UsageEvent[] = [];
  private settledEventIds = new Set<string>();

  record(event: UsageEvent): boolean {
    // Check if requestId already exists (idempotent)
    if (this.hasEvent(event.requestId)) {
      return false;
    }
    this.events.push(event);
    return true;
  }

  hasEvent(requestId: string): boolean {
    return this.events.some((e) => e.requestId === requestId);
  }

  getEvents(apiKey?: string): UsageEvent[] {
    if (apiKey) {
      return this.events.filter((e) => e.apiKey === apiKey);
    }
    return this.events;
  }

  getUnsettledEvents(): UsageEvent[] {
    return this.events.filter((e) => !this.settledEventIds.has(e.id));
  }

  markAsSettled(eventIds: string[], settlementId: string): void {
    eventIds.forEach((id) => this.settledEventIds.add(id));
  }

  // Helper methods for testing (not part of interface)
  addEvents(events: UsageEvent[]): void {
    events.forEach((event) => {
      if (!this.hasEvent(event.requestId)) {
        this.events.push(event);
      }
    });
  }

  clear(): void {
    this.events = [];
    this.settledEventIds.clear();
  }
}

// Mock API Registry
class MockApiRegistry implements ApiRegistry {
  private apis = new Map<
    string,
    {
      id: string;
      slug: string;
      base_url: string;
      developerId: string;
      endpoints: Array<{
        endpointId: string;
        path: string;
        priceUsdc: number;
      }>;
    }
  >();

  register(
    apiId: string,
    slug: string,
    baseUrl: string,
    developerId: string,
  ): void {
    this.apis.set(apiId, {
      id: apiId,
      slug,
      base_url: baseUrl,
      developerId,
      endpoints: [],
    });
  }

  resolve(slugOrId: string):
    | {
        id: string;
        slug: string;
        base_url: string;
        developerId: string;
        endpoints: Array<{
          endpointId: string;
          path: string;
          priceUsdc: number;
        }>;
      }
    | undefined {
    return (
      this.apis.get(slugOrId) ||
      Array.from(this.apis.values()).find((api) => api.slug === slugOrId)
    );
  }

  clear(): void {
    this.apis.clear();
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

describe("BillingService - Integration Tests", () => {
  test("successfully processes new billing request", async () => {
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
        requestId: "req_integration_001",
        userId: "user_alice",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        apiKeyId: "key_abc123",
        amountUsdc: "0.05",
      };

      const result = await billingService.deduct(request);

      assert.equal(result.success, true);
      assert.equal(result.alreadyProcessed, false);
      assert.ok(result.usageEventId);
      assert.ok(result.stellarTxHash);
      assert.equal(sorobanClient.getCallCount(), 1);

      // Verify record in database
      const dbResult = await testDb.pool.query(
        "SELECT * FROM usage_events WHERE request_id = $1",
        [request.requestId],
      );

      assert.equal(dbResult.rows.length, 1);
      assert.equal(dbResult.rows[0].user_id, "user_alice");
      assert.equal(dbResult.rows[0].api_id, "api_weather");
      assert.equal(Number(dbResult.rows[0].amount_usdc), 0.05);
      assert.ok(dbResult.rows[0].stellar_tx_hash);
    } finally {
      await testDb.end();
    }
  });

  test("prevents double charge on duplicate request_id", async () => {
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
        requestId: "req_duplicate_test",
        userId: "user_bob",
        apiId: "api_payment",
        endpointId: "endpoint_charge",
        apiKeyId: "key_xyz789",
        amountUsdc: "1.00",
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
      assert.equal(String(result2.usageEventId), String(result1.usageEventId));
      assert.equal(result2.stellarTxHash, result1.stellarTxHash);
      // Soroban should NOT be called again
      assert.equal(sorobanClient.getCallCount(), 1);

      // Verify only one record in database
      const dbResult = await testDb.pool.query(
        "SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1",
        [request.requestId],
      );
      assert.equal(String(dbResult.rows[0].count), "1");
    } finally {
      await testDb.end();
    }
  });

  test("leaves a pending row (stellar_tx_hash = NULL) when Soroban fails", async () => {
    // Design intent: Phase 1 (INSERT) commits before the Soroban call.
    // If Soroban fails, the pending row stays in the DB for reconciliation.
    // The caller receives success=false with the usageEventId so operators
    // can identify and void the pending row.
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
        requestId: "req_soroban_fail_test",
        userId: "user_charlie",
        apiId: "api_data",
        endpointId: "endpoint_query",
        apiKeyId: "key_fail123",
        amountUsdc: "0.10",
      };

      const result = await billingService.deduct(request);

      assert.equal(result.success, false);
      assert.ok(result.error?.includes("Soroban"));
      // usageEventId is populated so the pending row can be reconciled
      assert.ok(result.usageEventId);

      // Pending row exists with stellar_tx_hash = NULL
      const dbResult = await testDb.pool.query(
        "SELECT stellar_tx_hash FROM usage_events WHERE request_id = $1",
        [request.requestId],
      );
      assert.equal(dbResult.rows.length, 1);
      assert.equal(dbResult.rows[0].stellar_tx_hash, null);
    } finally {
      await testDb.end();
    }
  });

  test("handles concurrent requests with same request_id", async () => {
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
        requestId: "req_concurrent_test",
        userId: "user_david",
        apiId: "api_concurrent",
        endpointId: "endpoint_test",
        apiKeyId: "key_concurrent",
        amountUsdc: "0.25",
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
        (r) => r.alreadyProcessed,
      ).length;
      assert.ok(processedCount >= 1);

      // All should have the same usage event ID
      assert.equal(String(result1.usageEventId), String(result2.usageEventId));
      assert.equal(String(result2.usageEventId), String(result3.usageEventId));

      // Soroban should only be called once
      assert.equal(sorobanClient.getCallCount(), 1);

      // Verify only one record in database
      const dbResult = await testDb.pool.query(
        "SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1",
        [request.requestId],
      );
      assert.equal(String(dbResult.rows[0].count), "1");
    } finally {
      await testDb.end();
    }
  });

  test("getByRequestId returns existing usage event", async () => {
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
        requestId: "req_lookup_test",
        userId: "user_eve",
        apiId: "api_lookup",
        endpointId: "endpoint_get",
        apiKeyId: "key_lookup",
        amountUsdc: "0.15",
      };

      // Create usage event
      const deductResult = await billingService.deduct(request);
      assert.equal(deductResult.success, true);

      // Lookup by request ID
      const lookupResult = await billingService.getByRequestId(
        request.requestId,
      );
      assert.ok(lookupResult !== null);
      assert.equal(lookupResult.usageEventId, deductResult.usageEventId);
      assert.equal(lookupResult.stellarTxHash, deductResult.stellarTxHash);
      assert.equal(lookupResult.alreadyProcessed, true);
    } finally {
      await testDb.end();
    }
  });

  test("getByRequestId returns null for non-existent request", async () => {
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

      const result = await billingService.getByRequestId("req_nonexistent");
      assert.equal(result, null);
    } finally {
      await testDb.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Settlement/Invoice Generation End-to-End Integration Tests
// ---------------------------------------------------------------------------

describe("RevenueSettlementService - End-to-End Integration Tests", () => {
  test("successfully generates settlement invoice for single developer", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup: Register API and add usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 1.5,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_2",
        requestId: "req_002",
        apiKey: "key_xyz",
        apiKeyId: "key_xyz",
        apiId: "api_weather",
        endpointId: "endpoint_current",
        userId: "user_bob",
        amountUsdc: 2.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_3",
        requestId: "req_003",
        apiKey: "key_def",
        apiKeyId: "key_def",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_charlie",
        amountUsdc: 2.5,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 }, // Total: 6.00, exceeds minimum
    );

    const result = await settlementService.runBatch();

    // Verify batch results
    assert.equal(result.processed, 3);
    assert.equal(result.settledAmount, 6.0);
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify settlement record was created
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].developerId, "dev_123");
    assert.equal(settlements[0].amount, 6.0);
    assert.equal(settlements[0].status, "completed");
    assert.ok(settlements[0].tx_hash);
    assert.ok(settlements[0].created_at);

    // Verify events are marked as settled
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 0);
  });

  test("skips settlement when below minimum payout threshold", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup: Register API and add usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 1.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_2",
        requestId: "req_002",
        apiKey: "key_xyz",
        apiKeyId: "key_xyz",
        apiId: "api_weather",
        endpointId: "endpoint_current",
        userId: "user_bob",
        amountUsdc: 1.5,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 }, // Total: 2.50, below minimum
    );

    const result = await settlementService.runBatch();

    // Verify no settlement was created
    assert.equal(result.processed, 0);
    assert.equal(result.settledAmount, 0);
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 0);

    // Verify no settlement records
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 0);

    // Verify events remain unsettled
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 2);
  });

  test("handles settlement failure gracefully", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();
    settlementClient.setShouldFail(true);

    // Setup: Register API and add usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 3.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_2",
        requestId: "req_002",
        apiKey: "key_xyz",
        apiKeyId: "key_xyz",
        apiId: "api_weather",
        endpointId: "endpoint_current",
        userId: "user_bob",
        amountUsdc: 3.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 3.0 },
    );

    const result = await settlementService.runBatch();

    // Verify failure was handled
    assert.equal(result.processed, 0);
    assert.equal(result.settledAmount, 0);
    assert.equal(result.errors, 1);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify failed settlement record was created
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].developerId, "dev_123");
    assert.equal(settlements[0].amount, 6.0);
    assert.equal(settlements[0].status, "failed");
    assert.equal(settlements[0].tx_hash, null);

    // Verify events remain unsettled for retry
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 2);
  });

  test("processes multiple developers in single batch", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup: Register APIs for multiple developers
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );
    apiRegistry.register(
      "api_payment",
      "payment-api",
      "https://api.payment.com",
      "dev_456",
    );
    apiRegistry.register(
      "api_data",
      "data-api",
      "https://api.data.com",
      "dev_789",
    );

    const usageEvents: UsageEvent[] = [
      // dev_123 events (total: 6.00)
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 3.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_2",
        requestId: "req_002",
        apiKey: "key_xyz",
        apiKeyId: "key_xyz",
        apiId: "api_weather",
        endpointId: "endpoint_current",
        userId: "user_bob",
        amountUsdc: 3.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      // dev_456 events (total: 8.00)
      {
        id: "event_3",
        requestId: "req_003",
        apiKey: "key_def",
        apiKeyId: "key_def",
        apiId: "api_payment",
        endpointId: "endpoint_charge",
        userId: "user_charlie",
        amountUsdc: 4.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_4",
        requestId: "req_004",
        apiKey: "key_ghi",
        apiKeyId: "key_ghi",
        apiId: "api_payment",
        endpointId: "endpoint_refund",
        userId: "user_david",
        amountUsdc: 4.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      // dev_789 events (total: 2.00 - below threshold)
      {
        id: "event_5",
        requestId: "req_005",
        apiKey: "key_jkl",
        apiKeyId: "key_jkl",
        apiId: "api_data",
        endpointId: "endpoint_query",
        userId: "user_eve",
        amountUsdc: 2.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 3.0 },
    );

    const result = await settlementService.runBatch();

    // Verify batch results
    assert.equal(result.processed, 4); // 2 devs processed, 2 events each
    assert.equal(result.settledAmount, 14.0); // 6.00 + 8.00
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 2); // 2 successful settlements

    // Verify settlements for dev_123 and dev_456
    const dev123Settlements =
      settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(dev123Settlements.length, 1);
    assert.equal(dev123Settlements[0].amount, 6.0);
    assert.equal(dev123Settlements[0].status, "completed");

    const dev456Settlements =
      settlementStore.getDeveloperSettlements("dev_456");
    assert.equal(dev456Settlements.length, 1);
    assert.equal(dev456Settlements[0].amount, 8.0);
    assert.equal(dev456Settlements[0].status, "completed");

    // dev_789 should have no settlement (below threshold)
    const dev789Settlements =
      settlementStore.getDeveloperSettlements("dev_789");
    assert.equal(dev789Settlements.length, 0);

    // Verify events for dev_789 remain unsettled
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 1);
    assert.equal(unsettledEvents[0].id, "event_5");
  });

  test("respects batch size limits per developer", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup: Register API
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    // Create 5 events (total: 10.00) but limit batch to 3 events
    const usageEvents: UsageEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      usageEvents.push({
        id: `event_${i}`,
        requestId: `req_${i.toString().padStart(3, "0")}`,
        apiKey: `key_${i}`,
        apiKeyId: `key_${i}`,
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: `user_${i}`,
        amountUsdc: 2.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      });
    }

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0, maxEventsPerBatch: 3 },
    );

    const result = await settlementService.runBatch();

    // Verify only 3 events were processed (batch limit)
    assert.equal(result.processed, 3);
    assert.equal(result.settledAmount, 6.0); // 3 events × 2.00
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify settlement was created for processed amount
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amount, 6.0);
    assert.equal(settlements[0].status, "completed");

    // Verify 2 events remain unsettled for next batch
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 2);
    assert.equal(unsettledEvents[0].id, "event_4");
    assert.equal(unsettledEvents[1].id, "event_5");
  });

  test("handles orphaned events gracefully", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Add events for an API that doesn't exist in registry (orphaned)
    const orphanedEvents: UsageEvent[] = [
      {
        id: "event_orphaned_1",
        requestId: "req_orphaned_001",
        apiKey: "key_orphaned",
        apiKeyId: "key_orphaned",
        apiId: "api_nonexistent", // Not registered
        endpointId: "endpoint_missing",
        userId: "user_orphaned",
        amountUsdc: 5.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(orphanedEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 },
    );

    const result = await settlementService.runBatch();

    // Verify orphaned events were skipped
    assert.equal(result.processed, 0);
    assert.equal(result.settledAmount, 0);
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 0);

    // Verify no settlements created
    const settlements = settlementStore.getDeveloperSettlements("any_dev");
    assert.equal(settlements.length, 0);

    // Orphaned events remain unsettled (will be retried but skipped again)
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 1);
  });

  test("handles zero and negative amount events", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup: Register API
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_positive",
        requestId: "req_positive",
        apiKey: "key_positive",
        apiKeyId: "key_positive",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_positive",
        amountUsdc: 3.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_zero",
        requestId: "req_zero",
        apiKey: "key_zero",
        apiKeyId: "key_zero",
        apiId: "api_weather",
        endpointId: "endpoint_zero",
        userId: "user_zero",
        amountUsdc: 0.0, // Should be skipped
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_negative",
        requestId: "req_negative",
        apiKey: "key_negative",
        apiKeyId: "key_negative",
        apiId: "api_weather",
        endpointId: "endpoint_negative",
        userId: "user_negative",
        amountUsdc: -1.0, // Should be skipped
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 2.0 },
    );

    const result = await settlementService.runBatch();

    // Verify only positive amount event was processed
    assert.equal(result.processed, 1);
    assert.equal(result.settledAmount, 3.0);
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify settlement was created for positive amount only
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amount, 3.0);
    assert.equal(settlements[0].status, "completed");

    // Zero and negative events remain unsettled (will be skipped in future batches)
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 2);
    assert.ok(unsettledEvents.some((e) => e.id === "event_zero"));
    assert.ok(unsettledEvents.some((e) => e.id === "event_negative"));
  });
});

// ---------------------------------------------------------------------------
// Database-Backed End-to-End Invoice Generation Integration Tests
// ---------------------------------------------------------------------------

describe("Invoice Generation - Database Integration Tests", () => {
  test("end-to-end invoice generation with real database", async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();
    const settlementClient = new MockSorobanSettlementClient();

    try {
      // Create required tables
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

      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS apis (
          id VARCHAR(255) PRIMARY KEY,
          slug VARCHAR(255) NOT NULL,
          base_url VARCHAR(255) NOT NULL,
          developer_id VARCHAR(255) NOT NULL
        )
      `);

      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS settlements (
          id VARCHAR(255) PRIMARY KEY,
          developer_id VARCHAR(255) NOT NULL,
          amount NUMERIC NOT NULL,
          status VARCHAR(50) NOT NULL,
          tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL
        )
      `);

      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS settlement_events (
          usage_event_id INTEGER NOT NULL,
          settlement_id VARCHAR(255) NOT NULL,
          PRIMARY KEY (usage_event_id, settlement_id)
        )
      `);

      // Setup: Create API and billing records
      await testDb.pool.query(
        "INSERT INTO apis (id, slug, base_url, developer_id) VALUES ($1, $2, $3, $4)",
        ["api_weather", "weather-api", "https://api.weather.com", "dev_123"],
      );

      const billingService = new BillingService(testDb.pool, sorobanClient);

      // Create usage events through billing service
      const events = [
        {
          requestId: "req_invoice_001",
          userId: "user_alice",
          apiId: "api_weather",
          endpointId: "endpoint_forecast",
          apiKeyId: "key_abc",
          amountUsdc: "1.50",
        },
        {
          requestId: "req_invoice_002",
          userId: "user_bob",
          apiId: "api_weather",
          endpointId: "endpoint_current",
          apiKeyId: "key_xyz",
          amountUsdc: "2.00",
        },
        {
          requestId: "req_invoice_003",
          userId: "user_charlie",
          apiId: "api_weather",
          endpointId: "endpoint_forecast",
          apiKeyId: "key_def",
          amountUsdc: "2.50",
        },
      ];

      // Process billing events
      for (const event of events) {
        const result = await billingService.deduct(event);
        assert.equal(result.success, true);
        assert.ok(result.stellarTxHash);
      }

      // Verify usage events are in database
      const usageResult = await testDb.pool.query(
        "SELECT COUNT(*) as count, SUM(amount_usdc) as total FROM usage_events WHERE api_id = $1",
        ["api_weather"],
      );
      assert.equal(Number(usageResult.rows[0].count), 3);
      assert.equal(Number(usageResult.rows[0].total), 6.0);

      // Create settlement service with database-backed stores
      const dbUsageStore = new DatabaseUsageStore(testDb.db);
      const dbSettlementStore = new DatabaseSettlementStore(testDb.db);
      const dbApiRegistry = new DatabaseApiRegistry(testDb.db);

      const settlementService = new RevenueSettlementService(
        dbUsageStore,
        dbSettlementStore,
        dbApiRegistry,
        settlementClient,
        { minPayoutUsdc: 5.0 },
      );

      // Run settlement batch
      const settlementResult = await settlementService.runBatch();

      // Verify settlement results
      assert.equal(settlementResult.processed, 3);
      assert.equal(settlementResult.settledAmount, 6.0);
      assert.equal(settlementResult.errors, 0);
      assert.equal(settlementClient.getCallCount(), 1);

      // Verify settlement record in database
      const settlementDbResult = await testDb.pool.query(
        "SELECT * FROM settlements WHERE developer_id = $1",
        ["dev_123"],
      );
      assert.equal(settlementDbResult.rows.length, 1);
      assert.equal(settlementDbResult.rows[0].developer_id, "dev_123");
      assert.equal(Number(settlementDbResult.rows[0].amount), 6.0);
      assert.equal(settlementDbResult.rows[0].status, "completed");
      assert.ok(settlementDbResult.rows[0].tx_hash);

      // Verify all usage events are marked as settled (no unsettled events remain)
      const unsettledResult = dbUsageStore.getUnsettledEvents();
      assert.equal(unsettledResult.length, 0);
    } finally {
      await testDb.end();
    }
  });

  test("invoice generation with insufficient balance fails gracefully", async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();
    sorobanClient.setBalance("1000000"); // 0.1 USDC in contract units

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

      const request = {
        requestId: "req_insufficient_001",
        userId: "user_poor",
        apiId: "api_weather",
        endpointId: "endpoint_expensive",
        apiKeyId: "key_poor",
        amountUsdc: "1.00", // More than available balance
      };

      const result = await billingService.deduct(request);

      // Verify failure
      assert.equal(result.success, false);
      assert.ok(result.error?.includes("Insufficient balance"));
      assert.equal(result.usageEventId, "");

      // Verify no pending row was created
      const dbResult = await testDb.pool.query(
        "SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1",
        [request.requestId],
      );
      assert.equal(Number(dbResult.rows[0].count), 0);

      // Soroban should not have been called
      assert.equal(sorobanClient.getCallCount(), 0);
    } finally {
      await testDb.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Database-backed store implementations for integration tests
// ---------------------------------------------------------------------------

class DatabaseUsageStore implements UsageStore {
  constructor(private db: any) {}

  record(event: UsageEvent): boolean {
    try {
      this.db.public.none(`
        INSERT INTO usage_events
          (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at)
        VALUES
          ('${escapeSqlLiteral(event.userId)}',
           '${escapeSqlLiteral(event.apiId)}',
           '${escapeSqlLiteral(event.endpointId)}',
           '${escapeSqlLiteral(event.apiKeyId)}',
           ${event.amountUsdc},
           '${escapeSqlLiteral(event.requestId)}',
           NOW())
        ON CONFLICT (request_id) DO NOTHING
      `);
      return true;
    } catch {
      return false;
    }
  }

  hasEvent(requestId: string): boolean {
    try {
      const result = this.db.public.query(
        `SELECT 1 FROM usage_events WHERE request_id = '${escapeSqlLiteral(requestId)}'`,
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  getEvents(apiKey?: string): UsageEvent[] {
    try {
      const query = apiKey
        ? `SELECT * FROM usage_events WHERE api_key_id = '${escapeSqlLiteral(apiKey)}'`
        : "SELECT * FROM usage_events";
      const result = this.db.public.query(query);
      return result.rows.map(this.mapRowToEvent);
    } catch {
      return [];
    }
  }

  getUnsettledEvents(): UsageEvent[] {
    try {
      const result = this.db.public.query(`
        SELECT ue.* 
        FROM usage_events ue
        LEFT JOIN settlement_events se ON ue.id = se.usage_event_id
        WHERE se.usage_event_id IS NULL
        ORDER BY ue.created_at
      `);
      return result.rows.map(this.mapRowToEvent);
    } catch {
      return [];
    }
  }

  markAsSettled(eventIds: string[], settlementId: string): void {
    try {
      for (const eventId of eventIds) {
        this.db.public.none(`
          INSERT INTO settlement_events (usage_event_id, settlement_id)
          VALUES (${Number(eventId)}, '${escapeSqlLiteral(settlementId)}')
        `);
      }
    } catch {
      // Log error but don't throw for integration test
    }
  }

  private mapRowToEvent(row: any): UsageEvent {
    return {
      id: row.id.toString(),
      requestId: row.request_id,
      apiKey: row.api_key_id,
      apiKeyId: row.api_key_id,
      apiId: row.api_id,
      endpointId: row.endpoint_id,
      userId: row.user_id,
      amountUsdc: Number(row.amount_usdc),
      statusCode: 200,
      timestamp: row.created_at.toISOString(),
    };
  }
}

class DatabaseSettlementStore implements SettlementStore {
  constructor(private db: any) {}

  create(settlement: Settlement): void {
    const txHashValue = settlement.tx_hash
      ? `'${escapeSqlLiteral(settlement.tx_hash)}'`
      : "NULL";

    this.db.public.none(`
      INSERT INTO settlements (id, developer_id, amount, status, tx_hash, created_at)
      VALUES (
        '${escapeSqlLiteral(settlement.id)}',
        '${escapeSqlLiteral(settlement.developerId)}',
        ${settlement.amount},
        '${settlement.status}',
        ${txHashValue},
        '${escapeSqlLiteral(settlement.created_at)}'
      )
    `);
  }

  updateStatus(
    settlementId: string,
    status: "pending" | "completed" | "failed",
    txHash?: string | null,
  ): void {
    const txHashValue =
      txHash === undefined
        ? "tx_hash"
        : txHash === null
          ? "NULL"
          : `'${escapeSqlLiteral(txHash)}'`;

    this.db.public.none(`
      UPDATE settlements
      SET status = '${status}', tx_hash = ${txHashValue}
      WHERE id = '${escapeSqlLiteral(settlementId)}'
    `);
  }

  getDeveloperSettlements(developerId: string): Settlement[] {
    throw new Error("Not implemented for integration test");
  }
}

class DatabaseApiRegistry implements ApiRegistry {
  constructor(private db: any) {}

  resolve(slugOrId: string): ApiRegistryEntry | undefined {
    try {
      const result = this.db.public.query(
        `SELECT * FROM apis WHERE id = '${escapeSqlLiteral(slugOrId)}' OR slug = '${escapeSqlLiteral(slugOrId)}'`,
      );

      if (result.rows.length === 0) return undefined;

      const row = result.rows[0];
      return {
        id: row.id,
        slug: row.slug,
        base_url: row.base_url,
        developerId: row.developer_id,
        endpoints: [],
      };
    } catch {
      return undefined;
    }
  }

  register(): void {
    throw new Error("Not implemented for integration test");
  }
}

// ---------------------------------------------------------------------------
// Enhanced Security and Data-Integrity Validation Tests
// ---------------------------------------------------------------------------

describe("Invoice Generation - Security & Data Integrity Tests", () => {
  test("prevents duplicate settlement processing with idempotency", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API and usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 3.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 3.0 },
    );

    // First settlement batch
    const result1 = await settlementService.runBatch();
    assert.equal(result1.processed, 1);
    assert.equal(result1.settledAmount, 3.0);
    assert.equal(result1.errors, 0);
    assert.equal(settlementClient.getCallCount(), 1);

    // Second settlement batch - should find no unsettled events
    const result2 = await settlementService.runBatch();
    assert.equal(result2.processed, 0);
    assert.equal(result2.settledAmount, 0);
    assert.equal(result2.errors, 0);
    // Settlement client should not be called again
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify only one settlement record exists
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
  });

  test("maintains data consistency during settlement failure", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API and usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 6.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    // Configure settlement client to fail
    settlementClient.setShouldFail(true);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 },
    );

    // Run settlement batch - should fail
    const result = await settlementService.runBatch();
    assert.equal(result.processed, 0);
    assert.equal(result.settledAmount, 0);
    assert.equal(result.errors, 1);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify failed settlement record was created
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].status, "failed");
    assert.equal(settlements[0].tx_hash, null);

    // Verify events remain unsettled for retry
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 1);
    assert.equal(unsettledEvents[0].id, "event_1");

    // Verify data integrity - events can be retried
    settlementClient.setShouldFail(false);
    const retryResult = await settlementService.runBatch();
    assert.equal(retryResult.processed, 1);
    assert.equal(retryResult.settledAmount, 6.0);
    assert.equal(retryResult.errors, 0);
  });

  test("validates transaction boundaries in billing service", async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();
    sorobanClient.setShouldFail(true); // Force Soroban failure

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

      const request = {
        requestId: "req_boundary_test",
        userId: "user_boundary",
        apiId: "api_weather",
        endpointId: "endpoint_test",
        apiKeyId: "key_boundary",
        amountUsdc: "1.00",
      };

      const result = await billingService.deduct(request);

      // Verify failure
      assert.equal(result.success, false);
      assert.ok(result.error?.includes("Soroban"));

      // Verify pending row exists with stellar_tx_hash = NULL
      // This proves the INSERT committed before Soroban call
      const dbResult = await testDb.pool.query(
        "SELECT stellar_tx_hash FROM usage_events WHERE request_id = $1",
        [request.requestId],
      );
      assert.equal(dbResult.rows.length, 1);
      assert.equal(dbResult.rows[0].stellar_tx_hash, null);

      // Verify usageEventId is returned for reconciliation
      assert.ok(result.usageEventId);
    } finally {
      await testDb.end();
    }
  });

  test("ensures atomic settlement record creation", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API and usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 5.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 },
    );

    // Run settlement
    const result = await settlementService.runBatch();
    assert.equal(result.processed, 1);
    assert.equal(result.settledAmount, 5.0);
    assert.equal(result.errors, 0);

    // Verify atomic operation: settlement record exists and events are marked settled
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].status, "completed");
    assert.ok(settlements[0].tx_hash);

    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 0);

    // Verify settlement amount matches sum of events
    const totalEventAmount = usageEvents.reduce(
      (sum, event) => sum + event.amountUsdc,
      0,
    );
    assert.equal(settlements[0].amount, totalEventAmount);
  });
});

// ---------------------------------------------------------------------------
// Concurrent Settlement Processing Tests
// ---------------------------------------------------------------------------

describe("Invoice Generation - Concurrent Processing Tests", () => {
  test("handles concurrent settlement batches safely", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API and usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [];
    for (let i = 1; i <= 10; i++) {
      usageEvents.push({
        id: `event_${i}`,
        requestId: `req_${i.toString().padStart(3, "0")}`,
        apiKey: `key_${i}`,
        apiKeyId: `key_${i}`,
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: `user_${i}`,
        amountUsdc: 2.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      });
    }

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0, maxEventsPerBatch: 3 },
    );

    // Run multiple settlement batches concurrently
    const [result1, result2, result3] = await Promise.all([
      settlementService.runBatch(),
      settlementService.runBatch(),
      settlementService.runBatch(),
    ]);

    // Verify total processed events across all batches
    const totalProcessed =
      result1.processed + result2.processed + result3.processed;
    const totalSettled =
      result1.settledAmount + result2.settledAmount + result3.settledAmount;
    const totalErrors = result1.errors + result2.errors + result3.errors;

    // Same-instance concurrent callers should serialize and drain three batches.
    assert.equal(totalProcessed, 9);
    assert.equal(totalSettled, 18.0);
    assert.equal(totalErrors, 0);

    // Each serialized batch that meets threshold should result in one payout call.
    assert.equal(settlementClient.getCallCount(), 3);

    // Verify 1 event remains unsettled for next batch
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 1);
  });

  test("prevents duplicate settlement creation under concurrency", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API and usage events
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    const usageEvents: UsageEvent[] = [
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_abc",
        apiKeyId: "key_abc",
        apiId: "api_weather",
        endpointId: "endpoint_forecast",
        userId: "user_alice",
        amountUsdc: 10.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 },
    );

    // Run the same settlement batch multiple times concurrently
    const results = await Promise.all([
      settlementService.runBatch(),
      settlementService.runBatch(),
      settlementService.runBatch(),
      settlementService.runBatch(),
      settlementService.runBatch(),
    ]);

    // Only one should actually process events
    const processedCounts = results.map((r) => r.processed);
    const actualProcessed = processedCounts.reduce(
      (sum, count) => sum + count,
      0,
    );

    assert.equal(actualProcessed, 1); // Only one batch should process the event
    assert.equal(settlementClient.getCallCount(), 1); // Only one settlement call

    // Verify only one settlement record exists
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amount, 10.0);
    assert.equal(settlements[0].status, "completed");
  });

  test("handles concurrent billing and settlement processing", async () => {
    const testDb = createTestDb();
    const sorobanClient = new MockSorobanClient();
    const settlementClient = new MockSorobanSettlementClient();

    try {
      // Create required tables
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

      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS apis (
          id VARCHAR(255) PRIMARY KEY,
          slug VARCHAR(255) NOT NULL,
          base_url VARCHAR(255) NOT NULL,
          developer_id VARCHAR(255) NOT NULL
        )
      `);

      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS settlements (
          id VARCHAR(255) PRIMARY KEY,
          developer_id VARCHAR(255) NOT NULL,
          amount NUMERIC NOT NULL,
          status VARCHAR(50) NOT NULL,
          tx_hash VARCHAR(64),
          created_at TIMESTAMP NOT NULL
        )
      `);

      await testDb.pool.query(`
        CREATE TABLE IF NOT EXISTS settlement_events (
          usage_event_id INTEGER NOT NULL,
          settlement_id VARCHAR(255) NOT NULL,
          PRIMARY KEY (usage_event_id, settlement_id)
        )
      `);

      // Setup API
      await testDb.pool.query(
        "INSERT INTO apis (id, slug, base_url, developer_id) VALUES ($1, $2, $3, $4)",
        ["api_weather", "weather-api", "https://api.weather.com", "dev_123"],
      );

      const billingService = new BillingService(testDb.pool, sorobanClient);
      const dbUsageStore = new DatabaseUsageStore(testDb.db);
      const dbSettlementStore = new DatabaseSettlementStore(testDb.db);
      const dbApiRegistry = new DatabaseApiRegistry(testDb.db);

      const settlementService = new RevenueSettlementService(
        dbUsageStore,
        dbSettlementStore,
        dbApiRegistry,
        settlementClient,
        { minPayoutUsdc: 5.0 },
      );

      // Create billing events and run settlement concurrently
      const billingPromises = [];
      for (let i = 1; i <= 5; i++) {
        billingPromises.push(
          billingService.deduct({
            requestId: `req_concurrent_${i}`,
            userId: `user_${i}`,
            apiId: "api_weather",
            endpointId: "endpoint_forecast",
            apiKeyId: `key_${i}`,
            amountUsdc: "2.00",
          }),
        );
      }

      // Run billing and settlement concurrently. Depending on timing, the first
      // settlement run may observe only a subset of the events, so we follow it
      // with a second pass after billing completes.
      const [billingResults, settlementAttempt] = await Promise.all([
        Promise.all(billingPromises),
        settlementService.runBatch(),
      ]);

      const settlementResult = await settlementService.runBatch();

      // Verify all billing operations succeeded
      assert.equal(billingResults.filter((r) => r.success).length, 5);

      // Verify settlement processing eventually drains at least one payout batch.
      assert.ok(
        settlementAttempt.processed + settlementResult.processed > 0,
      );
      assert.ok(
        settlementAttempt.settledAmount + settlementResult.settledAmount > 0,
      );
    } finally {
      await testDb.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Edge Case and Failure Recovery Tests
// ---------------------------------------------------------------------------

describe("Invoice Generation - Edge Cases & Failure Recovery", () => {
  test("handles malformed usage events gracefully", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    // Add malformed events that should be skipped
    const malformedEvents: UsageEvent[] = [
      {
        id: "event_invalid_amount",
        requestId: "req_invalid",
        apiKey: "key_invalid",
        apiKeyId: "key_invalid",
        apiId: "api_weather",
        endpointId: "endpoint_invalid",
        userId: "user_invalid",
        amountUsdc: -5.0, // Negative amount
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_zero_amount",
        requestId: "req_zero",
        apiKey: "key_zero",
        apiKeyId: "key_zero",
        apiId: "api_weather",
        endpointId: "endpoint_zero",
        userId: "user_zero",
        amountUsdc: 0.0, // Zero amount
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_valid",
        requestId: "req_valid",
        apiKey: "key_valid",
        apiKeyId: "key_valid",
        apiId: "api_weather",
        endpointId: "endpoint_valid",
        userId: "user_valid",
        amountUsdc: 10.0, // Valid amount
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(malformedEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 },
    );

    const result = await settlementService.runBatch();

    // Should only process the valid event
    assert.equal(result.processed, 1);
    assert.equal(result.settledAmount, 10.0);
    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify malformed events remain unsettled
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 2);
    assert.ok(unsettledEvents.some((e) => e.id === "event_invalid_amount"));
    assert.ok(unsettledEvents.some((e) => e.id === "event_zero_amount"));
  });

  test("recovers from partial settlement failures", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup APIs for multiple developers
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );
    apiRegistry.register(
      "api_payment",
      "payment-api",
      "https://api.payment.com",
      "dev_456",
    );

    const usageEvents: UsageEvent[] = [
      // dev_123 events (will succeed)
      {
        id: "event_1",
        requestId: "req_001",
        apiKey: "key_1",
        apiKeyId: "key_1",
        apiId: "api_weather",
        endpointId: "endpoint_1",
        userId: "user_1",
        amountUsdc: 6.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      // dev_456 events (will fail)
      {
        id: "event_2",
        requestId: "req_002",
        apiKey: "key_2",
        apiKeyId: "key_2",
        apiId: "api_payment",
        endpointId: "endpoint_2",
        userId: "user_2",
        amountUsdc: 8.0,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(usageEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 5.0 },
    );

    // Configure settlement client to fail for dev_456 only
    let callCount = 0;
    settlementClient.setShouldFail(false);
    const originalDistribute =
      settlementClient.distribute.bind(settlementClient);
    settlementClient.distribute = async (
      developerId: string,
      amount: number,
    ) => {
      callCount++;
      if (developerId === "dev_456") {
        return {
          success: false,
          error: "Simulated failure for dev_456",
        };
      }
      return originalDistribute(developerId, amount);
    };

    const result = await settlementService.runBatch();

    // Verify partial success
    assert.equal(result.processed, 1); // Only dev_123 events processed
    assert.equal(result.settledAmount, 6.0); // Only dev_123 amount settled
    assert.equal(result.errors, 1); // dev_456 failed

    // Verify successful settlement for dev_123
    const dev123Settlements =
      settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(dev123Settlements.length, 1);
    assert.equal(dev123Settlements[0].status, "completed");

    // Verify failed settlement for dev_456
    const dev456Settlements =
      settlementStore.getDeveloperSettlements("dev_456");
    assert.equal(dev456Settlements.length, 1);
    assert.equal(dev456Settlements[0].status, "failed");

    // Verify dev_456 events remain unsettled for retry
    const unsettledEvents = usageStore.getUnsettledEvents();
    assert.equal(unsettledEvents.length, 1);
    assert.equal(unsettledEvents[0].id, "event_2");
  });

  test("handles extreme values and precision correctly", async () => {
    const usageStore = new MockUsageStore();
    const settlementStore = new InMemorySettlementStore();
    const apiRegistry = new MockApiRegistry();
    const settlementClient = new MockSorobanSettlementClient();

    // Setup API
    apiRegistry.register(
      "api_weather",
      "weather-api",
      "https://api.weather.com",
      "dev_123",
    );

    // Add events with extreme values
    const extremeEvents: UsageEvent[] = [
      {
        id: "event_small",
        requestId: "req_small",
        apiKey: "key_small",
        apiKeyId: "key_small",
        apiId: "api_weather",
        endpointId: "endpoint_small",
        userId: "user_small",
        amountUsdc: 0.0000001, // Very small amount
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
      {
        id: "event_large",
        requestId: "req_large",
        apiKey: "key_large",
        apiKeyId: "key_large",
        apiId: "api_weather",
        endpointId: "endpoint_large",
        userId: "user_large",
        amountUsdc: 999999.99, // Very large amount
        statusCode: 200,
        timestamp: new Date().toISOString(),
      },
    ];

    usageStore.addEvents(extremeEvents);

    const settlementService = new RevenueSettlementService(
      usageStore,
      settlementStore,
      apiRegistry,
      settlementClient,
      { minPayoutUsdc: 0.0000001 }, // Very low threshold
    );

    const result = await settlementService.runBatch();

    // Should process both events
    assert.equal(result.processed, 2);

    // Verify precision is maintained
    const expectedTotal = 0.0000001 + 999999.99;
    assert.equal(
      Math.abs(result.settledAmount - expectedTotal) < 0.000001,
      true,
    );

    assert.equal(result.errors, 0);
    assert.equal(settlementClient.getCallCount(), 1);

    // Verify settlement amount precision
    const settlements = settlementStore.getDeveloperSettlements("dev_123");
    assert.equal(settlements.length, 1);
    assert.equal(
      Math.abs(settlements[0].amount - expectedTotal) < 0.000001,
      true,
    );
  });

  test("validates input sanitization and security", async () => {
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

      // Test SQL injection attempts
      const maliciousRequests = [
        {
          requestId: "req'; DROP TABLE usage_events; --",
          userId: "user_normal",
          apiId: "api_weather",
          endpointId: "endpoint_normal",
          apiKeyId: "key_normal",
          amountUsdc: "1.00",
        },
        {
          requestId: "req_\\x00\\x01\\x02",
          userId: "user_normal",
          apiId: "api_weather",
          endpointId: "endpoint_normal",
          apiKeyId: "key_normal",
          amountUsdc: "1.00",
        },
      ];

      for (const request of maliciousRequests) {
        const result = await billingService.deduct(request);

        // Should either succeed (if input is properly sanitized) or fail gracefully
        if (result.success) {
          assert.ok(result.usageEventId);
          assert.ok(result.stellarTxHash);
        } else {
          assert.ok(result.error);
        }
      }

      // Verify table still exists and is intact
      const tableCheck = await testDb.pool.query(
        "SELECT COUNT(*) as count FROM usage_events",
      );
      assert.ok(tableCheck.rows.length > 0);
    } finally {
      await testDb.end();
    }
  });
});
