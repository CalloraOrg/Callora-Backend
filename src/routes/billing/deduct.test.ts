import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../middleware/errorHandler.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';
import { BillingService, type SorobanClient } from '../../services/billing.js';
import { createSorobanBillingService } from '../../services/createSorobanBillingService.js';
import { env } from '../../config/env.js';

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {
      return undefined;
    }
    close() {
      return undefined;
    }
  };
});

describe('POST /api/billing/deduct - developerId validation', () => {
  function buildApp(
    pool: Pool | null = { query: jest.fn() } as unknown as Pool,
    billingService?: BillingService,
  ) {
    const app = express();
    app.use(express.json());
    if (pool) {
      app.locals.dbPool = pool;
      app.locals.billingService = billingService ?? new BillingService(pool, {
        getBalance: jest.fn(),
        deductBalance: jest.fn(),
      });
    }
    app.use('/api/billing/deduct', deductRouter);
    app.use(errorHandler);
    return app;
  }

    expect(res.status).toBe(401);
  });

  it('returns 400 (not 500) when developerId is explicitly null', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${signToken()}`)
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('returns 400 when developerId is an empty string', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${signToken()}`)
      .send({ ...validPayload, developerId: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('returns 400 when developerId is not a string', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${signToken()}`)
      .send({ ...validPayload, developerId: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('falls back to the authenticated user id when developerId is omitted', async () => {
    // The billing service mock will throw so we never hit the DB, but the
    // request must have passed validation (no 400) and auth (no 401).
    const err = new Error('stop before DB write');
    mockBillingService({ throws: err });

    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${signToken()}`)
      .send(validPayload);

    // Validation and auth pass; the mock service throws → 500
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Soroban error category → HTTP status mapping
//
// Strategy: mock BillingService.deduct() to throw SorobanRpcError with a
// specific category, then assert the HTTP status, error code, and envelope
// shape. No running Soroban node is needed.
// ---------------------------------------------------------------------------

describe('POST /api/billing/deduct - SorobanRpcError category mapping', () => {
  // Shared assertion helper
  async function postDeduct(overrides: Record<string, unknown> = {}) {
    return request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${signToken()}`)
      .send({ ...validPayload, ...overrides });
  }

  // -------------------------------------------------------------------------
  // INSUFFICIENT_BALANCE → 402
  // -------------------------------------------------------------------------
  describe('INSUFFICIENT_BALANCE', () => {
    beforeEach(() => {
      mockBillingService({
        throws: new SorobanRpcError(
          'Insufficient balance to cover deduction',
          'INSUFFICIENT_BALANCE',
        ),
      });
    });

    it('returns HTTP 402', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(402);
    });

    it('returns error code INSUFFICIENT_BALANCE', async () => {
      const res = await postDeduct();
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('returns a well-formed error envelope', async () => {
      const res = await postDeduct();
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: expect.any(String),
        },
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------
  // TIMEOUT → 504
  // -------------------------------------------------------------------------
  describe('TIMEOUT', () => {
    beforeEach(() => {
      mockBillingService({
        throws: new SorobanRpcError(
          'Soroban RPC request timed out',
          'TIMEOUT',
        ),
      });
    });

    it('returns HTTP 504', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(504);
    });

    it('returns error code SOROBAN_RPC_TIMEOUT', async () => {
      const res = await postDeduct();
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SOROBAN_RPC_TIMEOUT');
    });

    it('returns a well-formed error envelope', async () => {
      const res = await postDeduct();
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'SOROBAN_RPC_TIMEOUT',
          message: expect.any(String),
        },
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------
  // CONTRACT_ERROR → 502
  // -------------------------------------------------------------------------
  describe('CONTRACT_ERROR', () => {
    beforeEach(() => {
      mockBillingService({
        throws: new SorobanRpcError(
          'Contract execution reverted',
          'CONTRACT_ERROR',
        ),
      });
    });

    it('returns HTTP 502', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(502);
    });

    it('returns error code SOROBAN_RPC_ERROR', async () => {
      const res = await postDeduct();
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SOROBAN_RPC_ERROR');
    });

    it('returns a well-formed error envelope', async () => {
      const res = await postDeduct();
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'SOROBAN_RPC_ERROR',
          message: expect.any(String),
        },
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------
  // NETWORK_ERROR → 502
  // -------------------------------------------------------------------------
  describe('NETWORK_ERROR', () => {
    beforeEach(() => {
      mockBillingService({
        throws: new SorobanRpcError(
          'Transport failure connecting to Soroban RPC',
          'NETWORK_ERROR',
        ),
      });
    });

    it('returns HTTP 502', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(502);
    });

    it('returns error code SOROBAN_RPC_ERROR', async () => {
      const res = await postDeduct();
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SOROBAN_RPC_ERROR');
    });

    it('returns a well-formed error envelope', async () => {
      const res = await postDeduct();
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'SOROBAN_RPC_ERROR',
          message: expect.any(String),
        },
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Unknown / unrecognised error → 500 via errorHandler, no internal leak
  // -------------------------------------------------------------------------
  describe('unknown error (non-SorobanRpcError fallthrough)', () => {
    beforeEach(() => {
      // A plain Error that is not a SorobanRpcError → hits `next(error)` →
      // errorHandler maps it to 500 with INTERNAL_SERVER_ERROR.
      mockBillingService({
        throws: new Error('Something completely unexpected'),
      });
    });

    it('returns HTTP 500', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(500);
    });

    it('returns error code INTERNAL_SERVER_ERROR', async () => {
      const res = await postDeduct();
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('does not leak internal error message or stack trace', async () => {
      const res = await postDeduct();
      // The error message must be the generic public message, not the raw
      // internal one. errorHandler uses safePublicMessage() which returns
      // 'Internal server error' for untrusted 500 errors.
      expect(res.body.error.message).not.toContain('Something completely unexpected');
      expect(res.body.error.message).toBe('Internal server error');
      // No stack trace in body
      expect(JSON.stringify(res.body)).not.toContain('at Object');
    });

    it('returns a well-formed error envelope without extra internal fields', async () => {
      const res = await postDeduct();
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal server error',
        },
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
      // No simulationDetails, stack, or raw error in the body
      expect(res.body.error.simulationDetails).toBeUndefined();
      expect(res.body.error.stack).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Simulation diagnostics: SorobanRpcError with simulationDetails → 502
  // with redacted body (no sensitive fields)
  // -------------------------------------------------------------------------
  describe('SorobanRpcError with simulationDetails (simulation failure path)', () => {
    const sensitiveSimulationDetails: SimulationDetails = {
      errorCode: 'CONTRACT_ERR_42',
      errorMessage: 'Wasm trap: out of gas',
      events: [{ type: 'event', address: 'GDUSER1STELLARADDRESS', balance: '999999' }],
      footprint: {
        source: 'GDSOURCE',
        destination: 'GDDEST',
        secretKey: 'SXXXXXXXX',
      },
    };

    beforeEach(() => {
      mockBillingService({
        throws: new SorobanRpcError(
          'Simulation failed',
          'CONTRACT_ERROR',
          sensitiveSimulationDetails,
        ),
      });
    });

    it('returns HTTP 502', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(502);
    });

    it('returns SIMULATION_FAILED code', async () => {
      const res = await postDeduct();
      expect(res.body.code).toBe('SIMULATION_FAILED');
    });

    it('includes redacted simulationDetails in the response body', async () => {
      const res = await postDeduct();
      // The route calls redactSimulationDetails() before sending
      expect(res.body.simulationDetails).toBeDefined();
    });

    it('redacts sensitive address/key fields from simulationDetails', async () => {
      const res = await postDeduct();
      const details = res.body.simulationDetails as Record<string, unknown>;
      const bodyStr = JSON.stringify(details);

      // Sensitive values from the original simulationDetails must not appear
      expect(bodyStr).not.toContain('GDUSER1STELLARADDRESS');
      expect(bodyStr).not.toContain('GDSOURCE');
      expect(bodyStr).not.toContain('GDDEST');
      expect(bodyStr).not.toContain('SXXXXXXXX');
      expect(bodyStr).not.toContain('999999');
    });

    it('preserves non-sensitive diagnostic fields (errorCode, errorMessage)', async () => {
      const res = await postDeduct();
      const details = res.body.simulationDetails as Record<string, unknown>;

      // errorCode and errorMessage are non-sensitive and should survive redaction
      expect(details.errorCode).toBe('CONTRACT_ERR_42');
      expect(details.errorMessage).toBe('Wasm trap: out of gas');
    });

    it('replaces event list with eventCount (not raw events)', async () => {
      const res = await postDeduct();
      const details = res.body.simulationDetails as Record<string, unknown>;

      // redactSimulationDetails replaces events with eventCount
      expect(details.eventCount).toBe(1);
      expect(details.events).toBeUndefined();
    });

    it('replaces footprint with footprintPresent flag', async () => {
      const res = await postDeduct();
      const details = res.body.simulationDetails as Record<string, unknown>;

      expect(details.footprintPresent).toBe(true);
      expect(details.footprint).toBeUndefined();
    });

    it('does not use the standard error envelope for the 502 simulation body', async () => {
      const res = await postDeduct();
      // The route sends a custom JSON object (not via errorHandler), so the
      // response lacks the envelope's `error.code` nested shape.
      expect(res.body.error).toBe('Soroban simulation failed');
      expect(res.body.code).toBe('SIMULATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Successful deduction → 200
  // -------------------------------------------------------------------------
  describe('successful deduction', () => {
    beforeEach(() => {
      mockBillingService({
        returns: {
          success: true,
          usageEventId: 'evt_abc123',
          stellarTxHash: 'tx_hash_xyz',
          alreadyProcessed: false,
          deductionApplied: true,
          reconciliationRequired: false,
        },
      });
    });

    it('returns HTTP 200', async () => {
      const res = await postDeduct();
      expect(res.status).toBe(200);
    });

    it('returns success payload with usageEventId and stellarTxHash', async () => {
      const res = await postDeduct();
      expect(res.body).toMatchObject({
        success: true,
        usageEventId: 'evt_abc123',
        stellarTxHash: 'tx_hash_xyz',
        alreadyProcessed: false,
      });
    });
  });

  it('fails clearly when the billing service is not configured', async () => {
    const app = buildApp();
    delete app.locals.billingService;

    const res = await request(app)
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('Billing service is not configured');
  });

  it('uses an injected fake Soroban client across requests without network access', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const fakeClient: jest.Mocked<SorobanClient> = {
      getBalance: jest.fn().mockResolvedValue({ balance: '0' }),
      deductBalance: jest.fn(),
    };
    const service = new BillingService(pool, fakeClient);
    const app = buildApp(pool, service);

    for (const requestId of ['req_first', 'req_second']) {
      const res = await request(app)
        .post('/api/billing/deduct')
        .set('x-user-id', 'user_123')
        .send({ ...validPayload, requestId });
      expect(res.status).toBe(402);
    }

    expect(app.locals.billingService).toBe(service);
    expect(fakeClient.getBalance).toHaveBeenCalledTimes(2);
    expect(fakeClient.deductBalance).not.toHaveBeenCalled();
  });

  it('uses the same injected service for deduction and request lookup', async () => {
    const result = {
      success: true,
      usageEventId: 'evt_1',
      stellarTxHash: 'tx_1',
      alreadyProcessed: false,
    };
    const fakeService = {
      deduct: jest.fn().mockResolvedValue(result),
      getByRequestId: jest.fn().mockResolvedValue(result),
    };
    const app = buildApp(
      { query: jest.fn() } as unknown as Pool,
      fakeService as unknown as BillingService,
    );

    const deducted = await request(app)
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);
    const lookup = await request(app)
      .get('/api/billing/deduct/request/req_1')
      .set('x-user-id', 'user_123');

    expect(deducted.status).toBe(200);
    expect(lookup.status).toBe(200);
    expect(fakeService.deduct).toHaveBeenCalledTimes(1);
    expect(fakeService.getByRequestId).toHaveBeenCalledWith('req_1');
    expect(app.locals.billingService).toBe(fakeService);
  });

  it('creates the billing client only once when the app starts', async () => {
    const fakeClient: jest.Mocked<SorobanClient> = {
      getBalance: jest.fn().mockResolvedValue({ balance: '0' }),
      deductBalance: jest.fn(),
    };
    const createBillingSorobanClient = jest.fn<
      SorobanClient,
      []
    >().mockReturnValue(fakeClient);
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    const service = createSorobanBillingService(pool, { createBillingSorobanClient });
    const app = buildApp(pool, service);
    expect(createBillingSorobanClient).toHaveBeenCalledTimes(1);

    for (const requestId of ['req_first', 'req_second']) {
      const res = await request(app)
        .post('/api/billing/deduct')
        .set('x-user-id', 'user_123')
        .send({ ...validPayload, requestId });
      expect(res.status).toBe(402);
    }

    expect(createBillingSorobanClient).toHaveBeenCalledTimes(1);
    expect(fakeClient.getBalance).toHaveBeenCalledTimes(2);
  });

  it('reuses the default billing service across app initializations', () => {
    const previousContractId = env.SOROBAN_BILLING_CONTRACT_ID;
    env.SOROBAN_BILLING_CONTRACT_ID = 'contract_123';
    try {
      const pool = { query: jest.fn() } as unknown as Pool;
      const first = createSorobanBillingService(pool);
      const second = createSorobanBillingService(pool);
      expect(first).toBeInstanceOf(BillingService);
      expect(second).toBe(first);
    } finally {
      env.SOROBAN_BILLING_CONTRACT_ID = previousContractId;
    }
  });
});
