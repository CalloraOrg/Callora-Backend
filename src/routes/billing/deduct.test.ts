import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { envelopeSchema } from '../../middleware/envelope.js';
import { BillingService } from '../../services/billing.js';
import { SorobanRpcError } from '../../services/sorobanBilling.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';

const JWT_SECRET = 'test-deduct-secret';

/**
 * `requireAuth` no longer trusts the `x-user-id` header (it requires an
 * authenticated gateway signature), so these tests mint a real HS256 token
 * instead of relying on a forwarded header.
 */
function makeToken(userId = 'user_123'): string {
  return jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

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

/** Raw RPC diagnostics, deliberately full of data that must never be published. */
const RAW_SIMULATION_DETAILS = {
  errorCode: -32000,
  errorMessage: 'contract failed',
  events: [{ contractAddress: 'CSECRETCONTRACT', balance: '9999999999' }],
  footprint: { contract: 'CVAULT', secret: 'S-SECRET-SEED' },
};

/** What `redactSimulationDetails` is expected to reduce the above to. */
const REDACTED_SUMMARY = {
  errorCode: -32000,
  errorMessage: 'contract failed',
  eventCount: 1,
  footprintPresent: true,
};

describe('POST /api/billing/deduct - developerId validation', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp(pool: Pool | null = { query: jest.fn() } as unknown as Pool) {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    if (pool) {
      app.locals.dbPool = pool;
    }
    app.use('/api/billing/deduct', deductRouter);
    app.use(errorHandler);
    return app;
  }

  const validPayload = {
    requestId: 'req_1',
    apiId: 'api_1',
    endpointId: 'endpoint_1',
    apiKeyId: 'key_1',
    amountUsdc: '0.01',
  };

  it('returns 400 (not 500) when developerId is explicitly null', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('returns 400 when developerId is an empty string', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...validPayload, developerId: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('returns 400 when developerId is not a string', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...validPayload, developerId: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toContain('developerId is required');
  });

  it('falls back to the authenticated user id when developerId is omitted', async () => {
    const queryMock = jest.fn().mockRejectedValue(new Error('stop before DB write'));
    const res = await request(buildApp({ query: queryMock } as unknown as Pool))
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(validPayload);

    // Validation passes and the request proceeds past developerId handling
    // (fails later at the DB layer, which is expected given the mocked pool).
    expect(res.status).not.toBe(400);
    expect(queryMock).toHaveBeenCalled();
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe(401);
  });

  it('returns 401 for an x-user-id header without an authenticated token', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/billing/deduct - simulation failure envelope', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(express.json());
    app.locals.dbPool = { query: jest.fn() } as unknown as Pool;
    app.use('/api/billing/deduct', deductRouter);
    app.use(errorHandler);
    return app;
  }

  const validPayload = {
    requestId: 'req_sim',
    apiId: 'api_1',
    endpointId: 'endpoint_1',
    apiKeyId: 'key_1',
    amountUsdc: '0.01',
  };

  function post(app: express.Express, requestId = 'req-sim-1') {
    return request(app)
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('x-request-id', requestId)
      .send(validPayload);
  }

  it('returns the standard envelope with SIMULATION_FAILED and a requestId', async () => {
    jest.spyOn(BillingService.prototype, 'deduct').mockResolvedValue({
      success: false,
      error: 'Soroban simulation failed',
      simulationDetails: RAW_SIMULATION_DETAILS,
    } as never);

    const res = await post(buildApp(), 'req-sim-1');

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SIMULATION_FAILED');
    expect(res.body.error.message).toBe('Soroban simulation failed');
    expect(res.body.requestId).toBe('req-sim-1');
    expect(typeof res.body.timestamp).toBe('string');

    // The response must satisfy the canonical envelope schema.
    expect(envelopeSchema.safeParse(res.body).success).toBe(true);
  });

  it('publishes only redacted simulation details', async () => {
    jest.spyOn(BillingService.prototype, 'deduct').mockResolvedValue({
      success: false,
      error: 'Soroban simulation failed',
      simulationDetails: RAW_SIMULATION_DETAILS,
    } as never);

    const res = await post(buildApp());

    expect(res.body.error.simulationDetails).toEqual(REDACTED_SUMMARY);

    // No raw diagnostic material may reach the client.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('CSECRETCONTRACT');
    expect(serialized).not.toContain('9999999999');
    expect(serialized).not.toContain('CVAULT');
    expect(serialized).not.toContain('S-SECRET-SEED');
  });

  it('routes a SorobanRpcError carrying simulation details through the same envelope', async () => {
    jest.spyOn(BillingService.prototype, 'deduct').mockRejectedValue(
      new SorobanRpcError('simulation failed', 'CONTRACT_ERROR', RAW_SIMULATION_DETAILS),
    );

    const res = await post(buildApp(), 'req-sim-2');

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SIMULATION_FAILED');
    expect(res.body.error.message).toBe('simulation failed');
    expect(res.body.requestId).toBe('req-sim-2');
    expect(res.body.error.simulationDetails).toEqual(REDACTED_SUMMARY);
    expect(envelopeSchema.safeParse(res.body).success).toBe(true);
  });

  it('still maps non-simulation SorobanRpcError categories to their own codes', async () => {
    jest
      .spyOn(BillingService.prototype, 'deduct')
      .mockRejectedValue(new SorobanRpcError('balance too low', 'INSUFFICIENT_BALANCE'));

    const res = await post(buildApp(), 'req-sim-3');

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.error.simulationDetails).toBeUndefined();
  });

  it('keeps a plain deduction failure on PaymentRequiredError', async () => {
    jest.spyOn(BillingService.prototype, 'deduct').mockResolvedValue({
      success: false,
      error: 'Billing deduction failed',
    } as never);

    const res = await post(buildApp(), 'req-sim-4');

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('BILLING_DEDUCTION_FAILED');
    expect(res.body.error.simulationDetails).toBeUndefined();
  });

  it('never writes simulation diagnostics to the console', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    jest.spyOn(BillingService.prototype, 'deduct').mockResolvedValue({
      success: false,
      error: 'Soroban simulation failed',
      simulationDetails: RAW_SIMULATION_DETAILS,
    } as never);

    const res = await post(buildApp());
    expect(res.status).toBe(502);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
