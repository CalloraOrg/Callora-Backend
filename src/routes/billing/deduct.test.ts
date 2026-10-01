import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { envelopeSchema } from '../../middleware/envelope.js';
import { SorobanRpcError } from '../../services/sorobanBilling.js';
import deductRouter from './deduct.js';
import type { Pool } from 'pg';
import { BillingService, type SorobanClient } from '../../services/billing.js';
import { createSorobanBillingService } from '../../services/createSorobanBillingService.js';
import { env } from '../../config/env.js';

const JWT_SECRET = 'test-deduct-secret';

/**
 * `requireAuth` no longer trusts the `x-user-id` header (it requires an
 * authenticated gateway signature), so these tests mint a real HS256 token
 * instead of relying on a forwarded header.
 */
function makeToken(userId = 'user_123'): string {
  return jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

jdest.mock('better-sqlite3', () => {
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

const mockDeduct = jest.fn();
jest.mock('../../services/billingService.js', () => {
  const actual = jest.requireActual('../../services/billingService.js');
  return {
    ...actual,
    BillingService: jest.fn().implementation(() => ({
      deduct: mockDeduct,
    })),
  };
});

beforeEach(() => {
  mockDeduct.mockReset();
});

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

  function buildApp(
    pool: Pool | null = { query: jest.fn() } as unknown as Pool,
    billingService?: BillingService,
  ) {
    const app = express();
    app.use(requestIdMiddleware);
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
    mockDeduct.mockResolved({ success: true });
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(mockDeduct).toHaveBeenCalled();
    const callArg = mockDeduct.mock.calls[0][0] as { userId: string };
    expect(callArg.userId).toBe(user_123');
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .send({ ...validPayload, developerId: null });

    expect(res.status).toBe401);
  });

  it('returns 403 when developerId differs from the authenticated user and does not call Soroban', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: 'user_456' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('allows developerId matching the authenticated user', async () => {
    mockDeduct.mockResolved({ success: true });
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send({ ...validPayload, developerId: 'user_123' });

    expect(res.status).toBe(200);
    expect(mockDeduct).toHaveBeenCalled();
  });

  it('allows admin to deduct on behalf of another user', async () => {
    mockDeduct.mockResolved({ success: true });
    const result = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-admin-api-key', 'test-admin-key')
      .send({ ...validPayload, developerId: 'user_456' });

    expect(result.status).toBe(200);
    expect(mockDeduct).toHaveBeenCalled();
  });

  it('returns 401 for an x-user-id header without an authenticated token', async () => {
    const res = await request(buildApp())
      .post('/api/billing/deduct')
      .set('x-user-id', 'user_123')
      .send(validPayload);

    expect(res.status).toBe(401);
  });

  it('fails clearly when the billing service is not configured', async () => {
    const app = buildApp();
    delete app.locals.billingService;

    const res = await request(app)
      .post('/api/billing/deduct')
      .set('Authorization', `Bearer ${makeToken()}`)
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
        .set('Authorization', `Bearer ${makeToken()}`)
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
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(validPayload);
    const lookup = await request(app)
      .get('/api/billing/deduct/request/req_1')
      .set('Authorization', `Bearer ${makeToken()}`);

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
        .set('Authorization', `Bearer ${makeToken()}`)
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
    const pool = { query: jest.fn() } as unknown as Pool;
    app.locals.dbPool = pool;
    app.locals.billingService = new BillingService(pool, {
      getBalance: jest.fn(),
      deductBalance: jest.fn(),
    });
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
