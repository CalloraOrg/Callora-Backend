import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../middleware/errorHandler.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';
import { BillingService } from '../../services/billing.js';
import { SorobanRpcError } from '../../services/sorobanBilling.js';
import type { SimulationDetails } from '../../lib/simulationDiagnostics.js';

// ---------------------------------------------------------------------------
// Module-level mocks (must be hoisted before any imports are executed)
// ---------------------------------------------------------------------------

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

jest.mock('../../services/sorobanBilling.js', () => {
  const actual = jest.requireActual('../../services/sorobanBilling.js');
  return {
    ...actual,
    createSorobanRpcBillingClient: jest.fn().mockReturnValue({
      getBalance: jest.fn(),
      deductBalance: jest.fn(),
    }),
  };
});

// BillingService is injected via createRouteBillingService inside the route.
// We mock the constructor so tests can control what deduct() throws/returns.
jest.mock('../../services/billing.js', () => {
  const actual = jest.requireActual('../../services/billing.js');
  return {
    ...actual,
    BillingService: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = 'test-secret-do-not-use-in-prod';

/** Sign a valid short-lived JWT for test requests. */
function signToken(userId = 'user_test_123'): string {
  return jwt.sign({ userId }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

/** Return an Express app wired up with the deduct router and error handler. */
function buildApp(pool: Pool = { query: jest.fn() } as unknown as Pool) {
  const app = express();
  app.use(express.json());
  app.locals.dbPool = pool;
  app.use('/api/billing/deduct', deductRouter);
  app.use(errorHandler);
  return app;
}

/** Minimal valid POST body for /api/billing/deduct. */
const validPayload = {
  requestId: 'req_1',
  apiId: 'api_1',
  endpointId: 'endpoint_1',
  apiKeyId: 'key_1',
  amountUsdc: '0.01',
};

// ---------------------------------------------------------------------------
// Helper: configure BillingService mock for a given test
// ---------------------------------------------------------------------------

type DeductMockResult =
  | { throws: Error }
  | { returns: Awaited<ReturnType<BillingService['deduct']>> };

function mockBillingService(result: DeductMockResult): void {
  const MockBillingService = BillingService as jest.MockedClass<typeof BillingService>;
  const deductFn = result instanceof Object && 'throws' in result
    ? jest.fn().mockRejectedValue((result as { throws: Error }).throws)
    : jest.fn().mockResolvedValue((result as { returns: unknown }).returns);

  MockBillingService.mockImplementation(() => ({
    deduct: deductFn,
    deductBulk: jest.fn(),
    getByRequestId: jest.fn().mockResolvedValue(null),
  }) as unknown as BillingService);
}

// ---------------------------------------------------------------------------
// Suite 1: pre-existing developerId validation tests (kept for regression)
// ---------------------------------------------------------------------------

describe('POST /api/billing/deduct - developerId validation', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .send({ ...validPayload, developerId: null });

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
});
