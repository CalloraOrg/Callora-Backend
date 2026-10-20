import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import {
  BillingPendingResolverClient,
  createBillingPendingResolverJob,
  resolvePendingDeductionsBatch,
} from "./billingPendingResolver.js";
import { register, resetBillingPendingMetrics } from "../metrics.js";

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

    CREATE TABLE audit_logs (
      id VARCHAR(64) PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      actor VARCHAR(255) NOT NULL,
      action VARCHAR(255) NOT NULL,
      target VARCHAR(255),
      details TEXT,
      previous_hash VARCHAR(64),
      integrity_hash VARCHAR(64)
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool() as unknown as Pool;
  return { db, pool };
}

describe("billingPendingResolver", () => {
  let pool: Pool;
  let mockAuditFn: jest.Mock;

  beforeEach(() => {
    resetBillingPendingMetrics();
    mockAuditFn = jest.fn().mockResolvedValue({ id: "mock-audit-id" });
    const testDb = setupTestDb();
    pool = testDb.pool;
  });

  afterEach(async () => {
    await pool.end?.();
  });

  test("Scenario 3: Submit timeout, then vault reports processed -> resolver confirms the row and stores the hash", async () => {
    const createdAt = new Date(Date.now() - 150_000); // 2.5 minutes ago (older than 2 min grace period)
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_timeout_success', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(true),
      getDeductEventTxHash: jest.fn().mockResolvedValue("tx_confirmed_hash_123"),
    };

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      validityWindowMs: 300_000,
      appendAuditFn: mockAuditFn,
    });

    expect(resolved).toBe(1);
    expect(client.isRequestProcessed).toHaveBeenCalledWith("req_timeout_success", "user_1");
    expect(client.getDeductEventTxHash).toHaveBeenCalledWith("req_timeout_success", "user_1");
    expect(mockAuditFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "deduction.confirmed",
        outcome: "success",
      }),
    );

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash, resolved_at, resolution_reason FROM usage_events WHERE request_id = 'req_timeout_success'",
      )
    ).rows[0];

    expect(row.deduction_status).toBe("confirmed");
    expect(row.stellar_tx_hash).toBe("tx_confirmed_hash_123");
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolution_reason).toContain("vault confirmed request processed");

    const metric = await register.getSingleMetricAsString("billing_pending_resolved_total");
    expect(metric).toContain('outcome="confirmed"} 1');
  });

  test("Scenario 4: Submit timeout, vault reports not processed, past validity -> resolver voids the row", async () => {
    const createdAt = new Date(Date.now() - 350_000); // 5.8 minutes ago (past 5 min validity)
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_timeout_expired', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(false),
    };

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      validityWindowMs: 300_000,
      appendAuditFn: mockAuditFn,
    });

    expect(resolved).toBe(1);
    expect(mockAuditFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "deduction.voided",
        outcome: "success",
      }),
    );

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash, resolved_at, resolution_reason FROM usage_events WHERE request_id = 'req_timeout_expired'",
      )
    ).rows[0];

    expect(row.deduction_status).toBe("voided");
    expect(row.stellar_tx_hash).toBeNull();
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolution_reason).toContain("Transaction validity window expired");

    const metric = await register.getSingleMetricAsString("billing_pending_resolved_total");
    expect(metric).toContain('outcome="voided"} 1');
  });

  test("Scenario 5: Vault reports not processed, still inside validity -> row stays pending", async () => {
    const createdAt = new Date(Date.now() - 150_000); // 2.5 minutes ago (older than 2m grace, but within 5m validity)
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_timeout_valid', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(false),
    };

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      validityWindowMs: 300_000,
      appendAuditFn: mockAuditFn,
    });

    expect(resolved).toBe(0);

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash, resolved_at FROM usage_events WHERE request_id = 'req_timeout_valid'",
      )
    ).rows[0];

    expect(row.deduction_status).toBe("pending");
    expect(row.stellar_tx_hash).toBeNull();
    expect(row.resolved_at).toBeNull();
  });

  test("Scenario 6: Phase 3 update fails after success -> resolver later confirms it; no void", async () => {
    // Row exists with stellar_tx_hash = NULL (because Phase 3 update failed), but on-chain it actually succeeded!
    const createdAt = new Date(Date.now() - 400_000); // Past validity window, but vault says PROCESSED!
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_phase3_failed', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      is_request_processed: jest.fn().mockResolvedValue(true),
      getDeductEventTxHash: jest.fn().mockResolvedValue("tx_recovered_hash"),
    };

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      validityWindowMs: 300_000,
      appendAuditFn: mockAuditFn,
    });

    expect(resolved).toBe(1);

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash, resolution_reason FROM usage_events WHERE request_id = 'req_phase3_failed'",
      )
    ).rows[0];

    expect(row.deduction_status).toBe("confirmed");
    expect(row.stellar_tx_hash).toBe("tx_recovered_hash");
    expect(row.resolution_reason).toContain("vault confirmed request processed");
  });

  test("Scenario 7: Two resolver instances on the same batch -> each row transitions once (SKIP LOCKED and status guard)", async () => {
    const createdAt = new Date(Date.now() - 400_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES
        ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_race_1', $1, 'pending', NULL),
        ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_race_2', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(true),
      getDeductEventTxHash: jest.fn().mockResolvedValue("tx_race_hash"),
    };

    // Run two batches concurrently
    const [res1, res2] = await Promise.all([
      resolvePendingDeductionsBatch(pool, client, { gracePeriodMs: 120_000, batchSize: 10, appendAuditFn: mockAuditFn }),
      resolvePendingDeductionsBatch(pool, client, { gracePeriodMs: 120_000, batchSize: 10, appendAuditFn: mockAuditFn }),
    ]);

    expect(res1 + res2).toBe(2);

    const rows = (
      await pool.query(
        "SELECT deduction_status FROM usage_events WHERE request_id IN ('req_race_1', 'req_race_2')",
      )
    ).rows;
    expect(rows.every((r) => r.deduction_status === "confirmed")).toBe(true);
  });

  test("Scenario 8: RPC error during resolution -> row untouched; error metric incremented", async () => {
    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_rpc_err', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockRejectedValue(new Error("Soroban RPC connection refused")),
    };

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      appendAuditFn: mockAuditFn,
    });

    expect(resolved).toBe(0);

    const row = (
      await pool.query(
        "SELECT deduction_status, stellar_tx_hash FROM usage_events WHERE request_id = 'req_rpc_err'",
      )
    ).rows[0];

    expect(row.deduction_status).toBe("pending");
    expect(row.stellar_tx_hash).toBeNull();

    const metric = await register.getSingleMetricAsString("billing_pending_resolved_total");
    expect(metric).toContain('outcome="error"} 1');
  });

  test("Scenario 10: Shutdown during a batch -> awaitIdle resolves after the in-flight batch; no new batch starts", async () => {
    let resolverDelayResolve: () => void = () => {};
    const delayPromise = new Promise<void>((resolve) => {
      resolverDelayResolve = resolve;
    });

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockImplementation(async () => {
        await delayPromise;
        return true;
      }),
    };

    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_shutdown_1', $1, 'pending', NULL)`,
      [createdAt],
    );

    const job = createBillingPendingResolverJob(pool, client, {
      intervalMs: 50,
      gracePeriodMs: 120_000,
      appendAuditFn: mockAuditFn,
    });

    job.start();
    // Allow start tick to launch
    await new Promise((r) => setTimeout(r, 10));

    job.beginShutdown();

    // Release the in-flight batch
    resolverDelayResolve();
    await job.awaitIdle();

    expect(client.isRequestProcessed).toHaveBeenCalledTimes(1);

    // Further interval ticks should not run
    await new Promise((r) => setTimeout(r, 120));
    expect(client.isRequestProcessed).toHaveBeenCalledTimes(1);

    job.stop();
  });

  test("Job lifecycle: start, stop, resolveBatch, and no-op guards", async () => {
    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(false),
    };

    const job = createBillingPendingResolverJob(pool, client, {
      intervalMs: 100,
      gracePeriodMs: 120_000,
    });

    // calling stop before start is a no-op
    job.stop();

    // resolveBatch directly
    const count = await job.resolveBatch();
    expect(count).toBe(0);

    job.start();
    // duplicate start is a no-op
    job.start();

    job.stop();

    // after beginShutdown, start is a no-op
    job.beginShutdown();
    job.start();
    await job.awaitIdle();
  });

  test("Handles client without is_request_processed method and fallback to is_request_processed", async () => {
    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_alt_method', $1, 'pending', NULL)`,
      [createdAt],
    );

    // Test snake_case method
    const clientSnake: BillingPendingResolverClient = {
      is_request_processed: jest.fn().mockResolvedValue(true),
    };
    const resolved = await resolvePendingDeductionsBatch(pool, clientSnake, {
      gracePeriodMs: 120_000,
      appendAuditFn: mockAuditFn,
    });
    expect(resolved).toBe(1);

    // Test client with neither method
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_no_method', $1, 'pending', NULL)`,
      [createdAt],
    );
    const clientNoMethod = {} as unknown as BillingPendingResolverClient;
    const resolvedNoMethod = await resolvePendingDeductionsBatch(pool, clientNoMethod, {
      gracePeriodMs: 120_000,
      appendAuditFn: mockAuditFn,
    });
    expect(resolvedNoMethod).toBe(0);
  });

  test("Returns 0 when candidateRows is empty", async () => {
    // With no pending rows in DB
    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(true),
    };
    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      appendAuditFn: mockAuditFn,
    });
    expect(resolved).toBe(0);
  });

  test("Handles getDeductEventTxHash error gracefully and proceeds with null hash", async () => {
    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_tx_err', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(true),
      getDeductEventTxHash: jest.fn().mockRejectedValue(new Error("RPC timeout fetching tx hash")),
    };

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      appendAuditFn: mockAuditFn,
    });
    expect(resolved).toBe(1);

    const row = (
      await pool.query("SELECT deduction_status, stellar_tx_hash FROM usage_events WHERE request_id = 'req_tx_err'")
    ).rows[0];
    expect(row.deduction_status).toBe("confirmed");
  });

  test("Handles audit failure gracefully without failing confirmation/voiding", async () => {
    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_audit_err', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(true),
      getDeductEventTxHash: jest.fn().mockResolvedValue("tx_audit_err_hash"),
    };

    const failingAuditFn = jest.fn().mockRejectedValue(new Error("Audit log DB down"));

    const resolved = await resolvePendingDeductionsBatch(pool, client, {
      gracePeriodMs: 120_000,
      appendAuditFn: failingAuditFn,
    });
    expect(resolved).toBe(1);
  });

  test("Job tick handles errors gracefully and prevents concurrent runs", async () => {
    let tickResolve: () => void = () => {};
    const tickPromise = new Promise<void>((resolve) => {
      tickResolve = resolve;
    });

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockImplementation(async () => {
        await tickPromise;
        throw new Error("Fatal batch failure");
      }),
    };

    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_tick_fail', $1, 'pending', NULL)`,
      [createdAt],
    );

    const job = createBillingPendingResolverJob(pool, client, {
      intervalMs: 10,
      gracePeriodMs: 120_000,
    });

    // Start running
    const run1 = job.resolveBatch();
    // Attempt concurrent run -> should return 0
    const run2 = await job.resolveBatch();
    expect(run2).toBe(0);

    tickResolve();
    const result1 = await run1;
    expect(result1).toBe(0);
  });

  test("Interval timer triggers tick", async () => {
    const createdAt = new Date(Date.now() - 150_000);
    await pool.query(
      `INSERT INTO usage_events
        (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at, deduction_status, stellar_tx_hash)
       VALUES ('user_1', 'api_1', 'ep_1', 'key_1', 100000, 'req_interval_tick', $1, 'pending', NULL)`,
      [createdAt],
    );

    const client: BillingPendingResolverClient = {
      isRequestProcessed: jest.fn().mockResolvedValue(false),
    };

    const job = createBillingPendingResolverJob(pool, client, {
      intervalMs: 20,
      gracePeriodMs: 120_000,
    });

    job.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    job.beginShutdown();
    await job.awaitIdle();

    expect(client.isRequestProcessed).toHaveBeenCalled();
  });
});
