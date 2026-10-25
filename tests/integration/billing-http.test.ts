/**
 * Billing HTTP Endpoints Integration Tests
 *
 * Tests billing HTTP routes end-to-end with authentication, validation,
 * and database integration. Includes unauthorized access attempts.
 */

import assert from "node:assert/strict";
import request from "supertest";
import type { Pool, QueryResult } from "pg";

jest.mock("uuid", () => ({ v4: () => "mock-uuid-1234" }));

// Mock better-sqlite3 to prevent native binding errors on Windows
jest.mock("better-sqlite3", () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

import { createTestDb, createUsageEventsTable } from "../helpers/db.js";
import { createApp } from "../../src/app.js";
import {
  BillingService,
  type SorobanClient,
} from "../../src/services/billing.js";
import jwt from "jsonwebtoken";
import { calculateRequestHash } from "../../src/middleware/idempotency.js";

// Only the external Soroban RPC seam is faked. The real BillingService, routes,
// error classes and sorobanBilling module exports are used unchanged.
function createSorobanClient(): SorobanClient {
  return {
    getBalance: jest.fn().mockResolvedValue({ balance: "100000000000" }),
    deductBalance: jest
      .fn()
      .mockResolvedValue({ txHash: "stellar-tx-hash-mock-123" }),
  };
}

// The app's default billing service is bound to the process-wide pool, so
// inject one bound to this test's database. The idempotency middleware reads
// app.locals.dbPool, so it is pointed at the same database.
function createTestApp(pool: Pool) {
  const app = createApp({
    billingService: new BillingService(pool, createSorobanClient()),
  });
  app.locals.dbPool = pool;
  return app;
}

// Helper to create mock JWT token
function createMockToken(userId: string = "user_123"): string {
  const secret = process.env.JWT_SECRET || "test-secret-key";
  return jwt.sign(
    { sub: userId, userId: userId, email: "test@example.com" },
    secret,
    { expiresIn: "1h" },
  );
}

// Helper to create authenticated request headers
function createAuthHeaders(token: string = createMockToken()) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("Billing HTTP Endpoints - Integration Tests", () => {
  describe("POST /api/billing/deduct", () => {
    test("successfully deducts balance with valid request", async () => {
      const testDb = createTestDb();
      const token = createMockToken("user_alice");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const requestBody = {
          requestId: "req_http_001",
          apiId: "api_weather",
          endpointId: "endpoint_forecast",
          apiKeyId: "key_abc123",
          amountUsdc: "0.05",
        };

        const response = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send(requestBody);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.ok(response.body.data.usageEventId);
        assert.ok(response.body.data.stellarTxHash);
        assert.equal(response.body.data.alreadyProcessed, false);

        // Verify record in database
        const dbResult = await testDb.pool.query(
          "SELECT * FROM usage_events WHERE request_id = $1",
          [requestBody.requestId],
        );

        assert.equal(dbResult.rows.length, 1);
        assert.equal(dbResult.rows[0].user_id, "user_alice");
        assert.equal(dbResult.rows[0].api_id, "api_weather");
        // 0.05 USDC is stored as 7-decimal contract units (1 USDC = 10_000_000).
        assert.equal(Number(dbResult.rows[0].amount_usdc), 500_000);
        assert.ok(dbResult.rows[0].stellar_tx_hash);
      } finally {
        await testDb.end();
      }
    });

    test("returns existing result for duplicate request_id", async () => {
      const testDb = createTestDb();
      const token = createMockToken("user_bob");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const requestBody = {
          requestId: "req_http_duplicate",
          apiId: "api_payment",
          endpointId: "endpoint_charge",
          apiKeyId: "key_xyz789",
          amountUsdc: "1.00",
        };

        // First request
        const response1 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send(requestBody);

        assert.equal(response1.status, 200);
        assert.equal(response1.body.success, true);
        assert.equal(response1.body.data.alreadyProcessed, false);

        // Second request with same request_id
        const response2 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send(requestBody);

        assert.equal(response2.status, 200);
        assert.equal(response2.body.success, true);
        assert.equal(response2.body.data.alreadyProcessed, true);
        assert.equal(
          response2.body.data.usageEventId,
          response1.body.data.usageEventId,
        );
        assert.equal(
          response2.body.data.stellarTxHash,
          response1.body.data.stellarTxHash,
        );

        // Verify only one record in database
        const dbResult = await testDb.pool.query(
          "SELECT COUNT(*) as count FROM usage_events WHERE request_id = $1",
          [requestBody.requestId],
        );
        assert.equal(String(dbResult.rows[0].count), "1");
      } finally {
        await testDb.end();
      }
    });

    test("handles Idempotency-Key header replays and conflicts", async () => {
      const testDb = createTestDb();
      const token = createMockToken("user_alice");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const requestBody = {
          requestId: "req_idem_001",
          apiId: "api_weather",
          endpointId: "endpoint_forecast",
          apiKeyId: "key_abc123",
          amountUsdc: "0.05",
        };

        const idempotencyKey = "idem-key-test-abc";

        // 1. First request - processes normally
        const response1 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .set("Idempotency-Key", idempotencyKey)
          .send(requestBody);

        assert.equal(response1.status, 200);
        assert.equal(response1.body.success, true);
        assert.equal(response1.body.data.alreadyProcessed, false);

        // 2. Replay request - returns original cached response and header
        const response2 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .set("Idempotency-Key", idempotencyKey)
          .send(requestBody);

        assert.equal(response2.status, 200);
        assert.equal(response2.header["idempotent-replayed"], "true");
        assert.equal(response2.body.success, true);
        assert.equal(
          response2.body.data.usageEventId,
          response1.body.data.usageEventId,
        );

        // 3. Request with different payload using same key - returns 409 Conflict
        const differentBody = { ...requestBody, amountUsdc: "1.00" };
        const response3 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .set("Idempotency-Key", idempotencyKey)
          .send(differentBody);

        assert.equal(response3.status, 409);
        assert.equal(
          response3.body.error.code,
          "IDEMPOTENCY_KEY_REUSE_MISMATCH",
        );

        // 4. Request with key that is currently in progress (started) - returns 409 Conflict
        const activeKey = "idem-started-key";
        // The stored hash must match what the middleware computes. Inside the
        // /deduct mount, req.path is "/".
        const reqHash = calculateRequestHash(
          "user_alice",
          requestBody,
          "POST",
          "/",
        );
        await testDb.pool.query(
          `INSERT INTO idempotency_store (scope, idempotency_key, request_hash, status, expires_at, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            "user_alice",
            activeKey,
            reqHash,
            "started",
            new Date(Date.now() + 60000).toISOString(),
            new Date(Date.now() + 60000).toISOString(),
          ],
        );

        const response4 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .set("Idempotency-Key", activeKey)
          .send(requestBody);

        assert.equal(response4.status, 409);
        assert.equal(response4.body.error.code, "IDEMPOTENCY_IN_PROGRESS");
      } finally {
        await testDb.end();
      }
    });

    test("validates required fields", async () => {
      const testDb = createTestDb();
      const token = createMockToken();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // Test missing requestId
        const response1 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send({
            apiId: "api_test",
            endpointId: "endpoint_test",
            apiKeyId: "key_test",
            amountUsdc: "0.01",
          });

        assert.equal(response1.status, 400);
        assert.equal(response1.body.error.code, "BAD_REQUEST");

        // Test invalid amount
        const response2 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send({
            requestId: "req_invalid_amount",
            apiId: "api_test",
            endpointId: "endpoint_test",
            apiKeyId: "key_test",
            amountUsdc: "-0.01",
          });

        assert.equal(response2.status, 400);
        assert.equal(response2.body.error.code, "BAD_REQUEST");

        // Test empty apiId
        const response3 = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send({
            requestId: "req_empty_api",
            apiId: "",
            endpointId: "endpoint_test",
            apiKeyId: "key_test",
            amountUsdc: "0.01",
          });

        assert.equal(response3.status, 400);
        assert.equal(response3.body.error.code, "BAD_REQUEST");
      } finally {
        await testDb.end();
      }
    });

    test("returns 400 when developerId is null", async () => {
      const testDb = createTestDb();
      const token = createMockToken("user_null_dev");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const response = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send({
            requestId: "req_null_developer_id",
            developerId: null,
            apiId: "api_test",
            endpointId: "endpoint_test",
            apiKeyId: "key_test",
            amountUsdc: "0.01",
          });

        assert.equal(response.status, 400);
        assert.equal(response.body.error.code, "BAD_REQUEST");
      } finally {
        await testDb.end();
      }
    });

    test("rejects unauthorized access", async () => {
      const testDb = createTestDb();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const requestBody = {
          requestId: "req_unauthorized",
          apiId: "api_test",
          endpointId: "endpoint_test",
          apiKeyId: "key_test",
          amountUsdc: "0.01",
        };

        // No authorization header
        const response1 = await request(app)
          .post("/api/billing/deduct")
          .send(requestBody);

        assert.equal(response1.status, 401);
        assert.equal(response1.body.error.code, "UNAUTHORIZED");

        // Invalid token
        const response2 = await request(app)
          .post("/api/billing/deduct")
          .set("Authorization", "Bearer invalid-token")
          .send(requestBody);

        assert.equal(response2.status, 401);
      } finally {
        await testDb.end();
      }
    });

    test("validates JSON response shape", async () => {
      const testDb = createTestDb();
      const token = createMockToken("user_shape_test");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const requestBody = {
          requestId: "req_shape_test",
          apiId: "api_shape",
          endpointId: "endpoint_shape",
          apiKeyId: "key_shape",
          amountUsdc: "0.42",
        };

        const response = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send(requestBody);

        assert.equal(response.status, 200);

        // Validate envelope structure
        const body = response.body;
        assert.deepEqual(Object.keys(body).sort(), [
          "data",
          "requestId",
          "success",
          "timestamp",
        ]);
        assert.equal(typeof body.success, "boolean");
        assert.equal(body.success, true);

        // Validate data payload
        const data = body.data;
        assert.equal(typeof data.success, "boolean");
        assert.equal(data.success, true);
        assert.equal(typeof data.usageEventId, "string");
        assert.ok(data.usageEventId.length > 0);
        assert.equal(typeof data.stellarTxHash, "string");
        assert.ok(data.stellarTxHash.length > 0);
        assert.equal(typeof data.alreadyProcessed, "boolean");
        assert.equal(data.alreadyProcessed, false);

        // Validate no extra fields (requestId is added to route bodies by responseEnrichMiddleware)
        const expectedKeys = [
          "success",
          "usageEventId",
          "stellarTxHash",
          "alreadyProcessed",
          "requestId",
        ];
        const actualKeys = Object.keys(data).sort();
        assert.deepEqual(actualKeys, expectedKeys.sort());
      } finally {
        await testDb.end();
      }
    });
  });

  describe("GET /api/billing/request/:requestId", () => {
    test("returns billing request status", async () => {
      const testDb = createTestDb();
      const token = createMockToken("user_lookup");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // First create a billing request
        const createResponse = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .send({
            requestId: "req_lookup_test",
            apiId: "api_lookup",
            endpointId: "endpoint_get",
            apiKeyId: "key_lookup",
            amountUsdc: "0.15",
          });

        assert.equal(createResponse.status, 200);

        // Then lookup by request ID
        const lookupResponse = await request(app)
          .get("/api/billing/request/req_lookup_test")
          .set(createAuthHeaders(token));

        assert.equal(lookupResponse.status, 200);
        assert.equal(lookupResponse.body.success, true);
        assert.equal(
          lookupResponse.body.data.usageEventId,
          createResponse.body.data.usageEventId,
        );
        assert.equal(
          lookupResponse.body.data.stellarTxHash,
          createResponse.body.data.stellarTxHash,
        );
        assert.equal(lookupResponse.body.data.alreadyProcessed, true);

        // Validate response structure
        const data = lookupResponse.body.data;
        assert.equal(typeof data.success, "boolean");
        assert.equal(typeof data.usageEventId, "string");
        assert.equal(typeof data.stellarTxHash, "string");
        assert.equal(typeof data.alreadyProcessed, "boolean");
      } finally {
        await testDb.end();
      }
    });

    test("returns 404 for non-existent request", async () => {
      const testDb = createTestDb();
      const token = createMockToken();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        const response = await request(app)
          .get("/api/billing/request/req_nonexistent")
          .set(createAuthHeaders(token));

        assert.equal(response.status, 404);
        assert.ok(response.body.requestId);
      } finally {
        await testDb.end();
      }
    });

    test("rejects unauthorized access to lookup endpoint", async () => {
      const testDb = createTestDb();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // No authorization header
        const response = await request(app)
          .get("/api/billing/request/req_test")
          .send();

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "UNAUTHORIZED");
      } finally {
        await testDb.end();
      }
    });

    test("validates requestId parameter", async () => {
      const testDb = createTestDb();
      const token = createMockToken();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // Empty requestId
        const response = await request(app)
          .get("/api/billing/request/")
          .set(createAuthHeaders(token));

        assert.equal(response.status, 404); // Express returns 404 for missing route param
      } finally {
        await testDb.end();
      }
    });
  });

  describe("Security and Data Integrity Tests", () => {
    test("prevents cross-user data access", async () => {
      const testDb = createTestDb();
      const token1 = createMockToken("user_security_1");
      const token2 = createMockToken("user_security_2");

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // User 1 creates a billing request
        const createResponse = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token1))
          .send({
            requestId: "req_cross_user",
            apiId: "api_security",
            endpointId: "endpoint_test",
            apiKeyId: "key_security",
            amountUsdc: "1.00",
          });

        assert.equal(createResponse.status, 200);

        const ownerLookup = await request(app)
          .get("/api/billing/request/req_cross_user")
          .set(createAuthHeaders(token1));
        assert.equal(ownerLookup.status, 200);
        assert.equal(ownerLookup.body.data.usageEventId, createResponse.body.data.usageEventId);

        // Another authenticated user must not discover this request.
        const lookupResponse = await request(app)
          .get("/api/billing/request/req_cross_user")
          .set(createAuthHeaders(token2));

        assert.equal(lookupResponse.status, 404);
        assert.equal(lookupResponse.body.data, undefined);
      } finally {
        await testDb.end();
      }
    });

    test("rejects reuse of another account's requestId on deduct", async () => {
      const testDb = createTestDb();
      const token1 = createMockToken("user_reuse_owner");
      const token2 = createMockToken("user_reuse_other");
      const sorobanClient = {
        getBalance: jest.fn().mockResolvedValue({ balance: "100000000000" }),
        deductBalance: jest.fn().mockResolvedValue({ txHash: "tx-owner" }),
      };

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createApp({
          billingService: new BillingService(testDb.pool, sorobanClient),
        });
        app.locals.dbPool = testDb.pool;
        const payload = {
          requestId: "req_reused",
          apiId: "api_security",
          endpointId: "endpoint_test",
          apiKeyId: "key_security",
          amountUsdc: "1.00",
        };

        const ownerDeduct = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token1))
          .send(payload);
        assert.equal(ownerDeduct.status, 200);

        // Another account replays the owner's requestId: rejected, no owner data, no second debit.
        const otherDeduct = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token2))
          .send(payload);

        assert.equal(otherDeduct.status, 402);
        assert.equal(otherDeduct.body.data, undefined);
        assert.doesNotMatch(JSON.stringify(otherDeduct.body), /constraint|duplicate key|usage_events/i);
        assert.equal(sorobanClient.deductBalance.mock.calls.length, 1);

        // Owner's row is unchanged and remains the only row for this requestId.
        const rows = await testDb.pool.query(
          "SELECT id, user_id, amount_usdc, stellar_tx_hash, deduction_status FROM usage_events WHERE request_id = $1",
          ["req_reused"],
        );
        assert.equal(rows.rows.length, 1);
        assert.equal(String(rows.rows[0].id), ownerDeduct.body.data.usageEventId);
        assert.equal(rows.rows[0].user_id, "user_reuse_owner");
        assert.equal(Number(rows.rows[0].amount_usdc), 10000000);
        assert.equal(rows.rows[0].stellar_tx_hash, "tx-owner");
        assert.equal(rows.rows[0].deduction_status, "confirmed");

        const ownerLookup = await request(app)
          .get("/api/billing/request/req_reused")
          .set(createAuthHeaders(token1));
        assert.equal(ownerLookup.status, 200);
        assert.equal(ownerLookup.body.data.usageEventId, ownerDeduct.body.data.usageEventId);
      } finally {
        await testDb.end();
      }
    });

    test("body developerId cannot charge or read another account", async () => {
      const testDb = createTestDb();
      const attackerToken = createMockToken("user_payer_attacker");
      const victimToken = createMockToken("user_payer_victim");
      const sorobanClient = {
        getBalance: jest.fn().mockResolvedValue({ balance: "100000000000" }),
        deductBalance: jest.fn().mockResolvedValue({ txHash: "tx-self" }),
      };

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createApp({
          billingService: new BillingService(testDb.pool, sorobanClient),
        });
        app.locals.dbPool = testDb.pool;
        const base = {
          apiId: "api_payer",
          endpointId: "endpoint_payer",
          apiKeyId: "key_payer",
          amountUsdc: "1.00",
        };

        // Attacker names the victim as payer: rejected before any debit.
        const charge = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(attackerToken))
          .send({ ...base, requestId: "req_victim_charge", developerId: "user_payer_victim" });
        assert.equal(charge.status, 403);
        assert.equal(charge.body.error.code, "FORBIDDEN");
        assert.equal(sorobanClient.deductBalance.mock.calls.length, 0);

        // Victim deducts for themselves.
        const victimDeduct = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(victimToken))
          .send({ ...base, requestId: "req_victim_own" });
        assert.equal(victimDeduct.status, 200);

        // Attacker names the victim and the victim's known requestId to read the result: rejected.
        const read = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(attackerToken))
          .send({ ...base, requestId: "req_victim_own", developerId: "user_payer_victim" });
        assert.equal(read.status, 403);
        assert.equal(read.body.data, undefined);
        assert.equal(read.body.stellarTxHash, undefined);

        // Attacker cannot discover the victim's request through the lookup route.
        const lookup = await request(app)
          .get("/api/billing/request/req_victim_own")
          .set(createAuthHeaders(attackerToken));
        assert.equal(lookup.status, 404);
        assert.equal(lookup.body.data, undefined);

        // Attacker's own payer path still works.
        const own = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(attackerToken))
          .send({ ...base, requestId: "req_attacker_own", developerId: "user_payer_attacker" });
        assert.equal(own.status, 200);
        assert.equal(sorobanClient.deductBalance.mock.calls.length, 2);

        const rows: QueryResult<{ user_id: string; request_id: string }> = await testDb.pool.query(
          "SELECT user_id, request_id FROM usage_events ORDER BY id",
        );
        assert.deepEqual(
          rows.rows.map((row) => [row.user_id, row.request_id]),
          [
            ["user_payer_victim", "req_victim_own"],
            ["user_payer_attacker", "req_attacker_own"],
          ],
        );
      } finally {
        await testDb.end();
      }
    });

    test("handles malformed JSON gracefully", async () => {
      const testDb = createTestDb();
      const token = createMockToken();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // Send malformed JSON
        const response = await request(app)
          .post("/api/billing/deduct")
          .set(createAuthHeaders(token))
          .set("Content-Type", "application/json")
          .send('{"invalid": json}');

        assert.equal(response.status, 400);
      } finally {
        await testDb.end();
      }
    });

    test("validates amount format and prevents negative values", async () => {
      const testDb = createTestDb();
      const token = createMockToken();

      try {
        await createUsageEventsTable(testDb.pool);

        const app = createTestApp(testDb.pool);

        // Test various invalid amount formats
        const invalidAmounts = [
          "0", // Zero amount
          "-1.00", // Negative amount
          "abc", // Non-numeric
          "1.5.0", // Invalid decimal format
          "", // Empty string
        ];

        for (const amount of invalidAmounts) {
          const response = await request(app)
            .post("/api/billing/deduct")
            .set(createAuthHeaders(token))
            .send({
              requestId: `req_invalid_${amount}`,
              apiId: "api_test",
              endpointId: "endpoint_test",
              apiKeyId: "key_test",
              amountUsdc: amount,
            });

          assert.equal(
            response.status,
            400,
            `Expected 400 for amount: ${amount}`,
          );
          assert.equal(
            response.body.error.code,
            "BAD_REQUEST",
            `Expected BAD_REQUEST for amount: ${amount}`,
          );
        }
      } finally {
        await testDb.end();
      }
    });
  });
});
