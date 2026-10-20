import { DataType, newDb } from "pg-mem";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { BillingService, type BillingDeductRequest, type SorobanClient } from "./billing.js";
import deductRouter from "../routes/billing/deduct.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { errorHandler } from "../middleware/errorHandler.js";
import { SorobanRpcError } from "./sorobanBilling.js";

const JWT_SECRET = "test-jwt-secret";

function makeToken(userId = "user_abc"): string {
  return jwt.sign({ userId, sub: userId }, JWT_SECRET, { expiresIn: "1h" });
}

function setupTestDb() {
  const db = newDb();
  db.public.registerFunction({
    name: "now",
    returns: DataType.timestamp,
    implementation: () => new Date(),
  });

  db.public.interceptQueries((sql) => {
    if (sql.includes("SKIP LOCKED")) {
      return db.public.many(sql.replace("SKIP LOCKED", ""));
    }
    return null;
  });

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
      deduction_status VARCHAR(16) NOT NULL DEFAULT 'pending',
      resolved_at TIMESTAMP,
      resolution_reason TEXT,
      UNIQUE (request_id, developer_id)
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as Pool;
  return { db, pool };
}

describe("BillingService deduction status transitions", () => {
  let pool: Pool;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  beforeEach(() => {
    const testDb = setupTestDb();
    pool = testDb.pool;
  });

  afterEach(async () => {
    await pool.end?.();
  });

  const baseRequest: BillingDeductRequest = {
    requestId: "req_status_123",
    userId: "user_abc",
    apiId: "api_1",
    endpointId: "ep_1",
    apiKeyId: "key_1",
    amountUsdc: "1.0000000",
  };

  test("Scenario 1: Soroban deduct succeeds -> row confirmed with hash", async () => {
    const sorobanClient: SorobanClient = {
      getBalance: jest.fn().mockResolvedValue({ balance: "100000000" }),
      deductBalance: jest.fn().mockResolvedValue({ txHash: "tx_hash_success_1" }),
    };

    const service = new BillingService(pool, sorobanClient);
    const result = await service.deduct(baseRequest);

    expect(result.success).toBe(true);
    expect(result.deductionStatus).toBe("confirmed");
    expect(result.stellarTxHash).toBe("tx_hash_success_1");
    expect(result.reconciliationRequired).toBe(false);

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash, resolved_at FROM usage_events WHERE request_id = 'req_status_123'",
      )
    ).rows[0];

    expect(row.deduction_status).toBe("confirmed");
    expect(row.stellar_tx_hash).toBe("tx_hash_success_1");
    expect(row.resolved_at).toBeTruthy();
  });

  test("Scenario 2 & Regression proof: Simulation rejects with InsufficientBalance -> row voided immediately; same requestId retry is accepted and charges once", async () => {
    let callCount = 0;
    const sorobanClient: SorobanClient = {
      getBalance: jest.fn().mockResolvedValue({ balance: "100000000" }),
      deductBalance: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new SorobanRpcError("Simulation failed: Insufficient balance", "INSUFFICIENT_BALANCE");
        }
        return { txHash: "tx_hash_retry_success" };
      }),
    };

    const service = new BillingService(pool, sorobanClient);

    // Attempt 1: Simulation rejects
    const result1 = await service.deduct(baseRequest);
    expect(result1.success).toBe(false);
    expect(result1.deductionStatus).toBe("voided");
    expect(result1.reconciliationRequired).toBe(false);

    // Verify row in DB is voided immediately
    const rowAfterAttempt1 = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash, resolved_at, resolution_reason FROM usage_events WHERE request_id = 'req_status_123'",
      )
    ).rows[0];
    expect(rowAfterAttempt1.deduction_status).toBe("voided");
    expect(rowAfterAttempt1.stellar_tx_hash).toBeNull();
    expect(rowAfterAttempt1.resolution_reason).toContain("INSUFFICIENT_BALANCE");

    // Attempt 2: Same requestId retried -> accepted and charges successfully!
    // On main before this fix, this would return 409 forever. Now it re-arms and succeeds.
    const result2 = await service.deduct(baseRequest);
    expect(result2.success).toBe(true);
    expect(result2.deductionStatus).toBe("confirmed");
    expect(result2.stellarTxHash).toBe("tx_hash_retry_success");
    expect(result2.reconciliationRequired).toBe(false);

    const rowAfterAttempt2 = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash FROM usage_events WHERE request_id = 'req_status_123'",
      )
    ).rows[0];
    expect(rowAfterAttempt2.deduction_status).toBe("confirmed");
    expect(rowAfterAttempt2.stellar_tx_hash).toBe("tx_hash_retry_success");
  });

  test("Unknown outcomes (TIMEOUT, NETWORK_ERROR) stay pending and require reconciliation", async () => {
    const sorobanClient: SorobanClient = {
      getBalance: jest.fn().mockResolvedValue({ balance: "100000000" }),
      deductBalance: jest.fn().mockRejectedValue(new SorobanRpcError("Request timed out", "TIMEOUT")),
    };

    const service = new BillingService(pool, sorobanClient, { retryDelaysMs: [] });
    const result = await service.deduct(baseRequest);

    expect(result.success).toBe(false);
    expect(result.deductionStatus).toBe("pending");
    expect(result.reconciliationRequired).toBe(true);

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash FROM usage_events WHERE request_id = 'req_status_123'",
      )
    ).rows[0];
    expect(row.deduction_status).toBe("pending");
    expect(row.stellar_tx_hash).toBeNull();
  });

  test("Scenario 9: Deduct retry on a pending row -> 409 envelope with deductionStatus: 'pending'", async () => {
    const sorobanClient: SorobanClient = {
      getBalance: jest.fn().mockResolvedValue({ balance: "100000000" }),
      deductBalance: jest.fn().mockRejectedValue(new SorobanRpcError("Gateway timeout", "TIMEOUT")),
    };

    const service = new BillingService(pool, sorobanClient, { retryDelaysMs: [] });

    // App with deduct router
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.locals.dbPool = pool;
    app.locals.billingService = service;
    app.use("/api/billing/deduct", deductRouter);
    app.use(errorHandler);

    // Initial attempt times out and leaves pending row
    const res1 = await request(app)
      .post("/api/billing/deduct")
      .set("Authorization", `Bearer ${makeToken("user_abc")}`)
      .send({
        requestId: "req_retry_pending",
        developerId: "user_abc",
        apiId: "api_1",
        endpointId: "ep_1",
        apiKeyId: "key_1",
        amountUsdc: "1.0000000",
      });

    expect(res1.status).toBe(409);
    expect(res1.body.success).toBe(false);
    expect(res1.body.error.code).toBe("RECONCILIATION_REQUIRED");
    expect(res1.body.deductionStatus).toBe("pending");
    expect(res1.body.reconciliationRequired).toBe(true);
    expect(res1.body.usageEventId).toBeTruthy();

    // Retry with the same requestId while still pending
    const res2 = await request(app)
      .post("/api/billing/deduct")
      .set("Authorization", `Bearer ${makeToken("user_abc")}`)
      .send({
        requestId: "req_retry_pending",
        developerId: "user_abc",
        apiId: "api_1",
        endpointId: "ep_1",
        apiKeyId: "key_1",
        amountUsdc: "1.0000000",
      });

    expect(res2.status).toBe(409);
    expect(res2.body.success).toBe(false);
    expect(res2.body.error.code).toBe("RECONCILIATION_REQUIRED");
    expect(res2.body.deductionStatus).toBe("pending");
    expect(res2.body.reconciliationRequired).toBe(true);
  });
});
