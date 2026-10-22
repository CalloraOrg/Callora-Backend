import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { DataType, newDb } from 'pg-mem';
import {
  createBillingForecastRouter,
  roundHalfUp,
  formatUnitsToUsdc,
  getPeriodDays,
} from './forecast.js';
import type { BillingForecastRouterDeps } from './forecast.js';
import {
  PgUsageEventsRepository,
  type UsageEventsRepositoryQueryable,
} from '../../repositories/usageEventsRepository.pg.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

function authHeader(userId: string): string {
  return `Bearer ${jwt.sign({ userId, sub: userId }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function createPgMemRepository() {
  const db = newDb();
  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date(),
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
      UNIQUE (request_id, developer_id)
    );

    CREATE INDEX idx_usage_events_user_created ON usage_events(user_id, created_at);
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    repository: new PgUsageEventsRepository(pool as UsageEventsRepositoryQueryable),
    pool,
  };
}

function buildApp(options: BillingForecastRouterDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  if (options.pool) {
    app.locals.dbPool = options.pool;
  }
  if (options.usageEventsRepository) {
    app.locals.usageEventsRepository = options.usageEventsRepository;
  }
  app.use('/api/billing/forecast', createBillingForecastRouter(options));
  app.use(errorHandler);
  return app;
}

describe('Exact Math Helpers', () => {
  it('roundHalfUp rounds correctly on integer division', () => {
    // 3 / 30 = 0.1 -> 0
    expect(roundHalfUp(3n, 30n)).toBe(0n);
    // 15 / 30 = 0.5 -> 1 (half up)
    expect(roundHalfUp(15n, 30n)).toBe(1n);
    // 14 / 30 = 0.466... -> 0
    expect(roundHalfUp(14n, 30n)).toBe(0n);
    // 16 / 30 = 0.533... -> 1
    expect(roundHalfUp(16n, 30n)).toBe(1n);
    // 100_000_000 * 90 / 7 = 9_000_000_000 / 7 = 1_285_714_285.714... -> 1_285_714_286
    expect(roundHalfUp(9_000_000_000n, 7n)).toBe(1_285_714_286n);
    // 100_000_000 / 7 = 14_285_714.285... -> 14_285_714
    expect(roundHalfUp(100_000_000n, 7n)).toBe(14_285_714n);
  });

  it('roundHalfUp throws on division by zero', () => {
    expect(() => roundHalfUp(10n, 0n)).toThrow('Denominator must be non-zero');
  });

  it('formatUnitsToUsdc formats integer units to exact 7-decimal USDC string', () => {
    expect(formatUnitsToUsdc(0n)).toBe('0.0000000');
    expect(formatUnitsToUsdc(3n)).toBe('0.0000003');
    expect(formatUnitsToUsdc(10n)).toBe('0.0000010');
    expect(formatUnitsToUsdc(10_000_000n)).toBe('1.0000000');
    expect(formatUnitsToUsdc(90_000_000n)).toBe('9.0000000');
    expect(formatUnitsToUsdc(128_5714286n)).toBe('128.5714286');
  });

  it('getPeriodDays returns expected day counts', () => {
    expect(getPeriodDays('day')).toBe(1);
    expect(getPeriodDays('week')).toBe(7);
    expect(getPeriodDays('month')).toBe(30);
    expect(getPeriodDays('next_30_days')).toBe(30);
    expect(getPeriodDays('quarter')).toBe(90);
  });
});

describe('GET /api/billing/forecast', () => {
  it('returns 401 Unauthorized if user is not authenticated', async () => {
    const { repository } = createPgMemRepository();
    const app = buildApp({ usageEventsRepository: repository });

    const res = await request(app).get('/api/billing/forecast');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // Scenario 1: Spend of 0.0000003 over 30 days -> exact 7-decimal values, not 0.0000
  it('Scenario 1: returns exact 7-decimal values for 0.0000003 spend over 30 days', async () => {
    const { repository, pool } = createPgMemRepository();
    const userId = 'dev-user-scenario-1';

    // 0.0000003 USDC = 3 integer units
    await repository.create({
      userId,
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 3n,
      requestId: 'req-scen-1',
      stellarTxHash: 'tx-confirmed-1',
      createdAt: new Date(Date.now() - 5 * 86_400_000),
    });

    const app = buildApp({ usageEventsRepository: repository, pool });
    const res = await request(app)
      .get('/api/billing/forecast?lookbackDays=30&period=month')
      .set('Authorization', authHeader(userId));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId,
      lookbackDays: 30,
      windowSpentUsdc: '0.0000003',
      dailyRunRateUsdc: '0.0000000',
      forecastPeriod: 'month',
      forecastDays: 30,
      forecastedAmountUsdc: '0.0000003',
      totalCalls: 1,
      currency: 'USDC',
    });
    expect(res.body.lookbackStart).toBeDefined();
    expect(res.body.lookbackEnd).toBeDefined();
    expect(res.body.generatedAt).toBeDefined();
  });

  // Scenario 2: Caller is also an API owner with revenue -> revenue excluded from spend
  it('Scenario 2: excludes developer revenue when caller is also an API owner', async () => {
    const { repository, pool } = createPgMemRepository();
    const userId = 'dev-user-dual-role';

    // 1. Caller spent 50 USDC as a consumer (userId = caller)
    await repository.create({
      userId,
      apiId: 'api-weather',
      endpointId: 'ep-weather',
      apiKeyId: 'key-weather',
      developerId: 'weather-owner',
      amount: 50_0000000n,
      requestId: 'req-consumer-spend',
      stellarTxHash: 'tx-spend-1',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });

    // 2. Another consumer called caller's API (developerId = caller, userId = other-user) -> REVENUE
    await repository.create({
      userId: 'other-consumer-xyz',
      apiId: 'caller-owned-api',
      endpointId: 'ep-calc',
      apiKeyId: 'key-other',
      developerId: userId,
      amount: 100_0000000n,
      requestId: 'req-developer-revenue',
      stellarTxHash: 'tx-revenue-1',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const app = buildApp({ usageEventsRepository: repository, pool });
    const res = await request(app)
      .get('/api/billing/forecast?lookbackDays=30&period=month')
      .set('Authorization', authHeader(userId));

    expect(res.status).toBe(200);
    // Only the 50 USDC consumer spend is included; 100 USDC revenue is excluded
    expect(res.body.windowSpentUsdc).toBe('50.0000000');
    expect(res.body.forecastedAmountUsdc).toBe('50.0000000');
    expect(res.body.totalCalls).toBe(1);
  });

  // Scenario 3: Pending (unconfirmed) charges -> excluded
  it('Scenario 3: excludes pending charges with no stellar_tx_hash', async () => {
    const { repository, pool } = createPgMemRepository();
    const userId = 'dev-user-pending-test';

    // Confirmed charge (stellar_tx_hash present)
    await repository.create({
      userId,
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 20_0000000n,
      requestId: 'req-confirmed',
      stellarTxHash: 'tx-confirmed-hash',
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    });

    // Pending / unconfirmed charge (stellar_tx_hash is null)
    await repository.create({
      userId,
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 80_0000000n,
      requestId: 'req-unconfirmed',
      stellarTxHash: null,
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    });

    const app = buildApp({ usageEventsRepository: repository, pool });
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader(userId));

    expect(res.status).toBe(200);
    // Only the 20 USDC confirmed charge is counted
    expect(res.body.windowSpentUsdc).toBe('20.0000000');
    expect(res.body.totalCalls).toBe(1);
  });

  // Scenario 4: Repository throws -> 503 FORECAST_DATA_UNAVAILABLE, not a zero forecast
  it('Scenario 4: returns 503 FORECAST_DATA_UNAVAILABLE when repository fails', async () => {
    const failingRepo = {
      sumSpendByConsumer: jest.fn().mockRejectedValue(new Error('Database disk error')),
    };

    const app = buildApp({ usageEventsRepository: failingRepo });
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader('dev-user-error'));

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'FORECAST_DATA_UNAVAILABLE',
    });
  });

  // Scenario 5: No usage -> zero forecast with 200
  it('Scenario 5: returns zero forecast with 200 when user has no usage', async () => {
    const { repository, pool } = createPgMemRepository();
    const app = buildApp({ usageEventsRepository: repository, pool });

    const res = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader('dev-user-empty'));

    expect(res.status).toBe(200);
    expect(res.body.windowSpentUsdc).toBe('0.0000000');
    expect(res.body.dailyRunRateUsdc).toBe('0.0000000');
    expect(res.body.forecastedAmountUsdc).toBe('0.0000000');
    expect(res.body.totalCalls).toBe(0);
  });

  // Scenario 6: period=quarter, lookbackDays=7 -> forecast equals round(total × days / 7)
  it('Scenario 6: calculates forecast correctly for period=quarter and lookbackDays=7', async () => {
    const { repository, pool } = createPgMemRepository();
    const userId = 'dev-user-quarter';

    // 10 USDC spend in smallest units: 10_0000000 = 100_000_000n units
    await repository.create({
      userId,
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100_000_000n,
      requestId: 'req-q-1',
      stellarTxHash: 'tx-q-1',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const app = buildApp({ usageEventsRepository: repository, pool });
    const res = await request(app)
      .get('/api/billing/forecast?period=quarter&lookbackDays=7')
      .set('Authorization', authHeader(userId));

    expect(res.status).toBe(200);
    expect(res.body.lookbackDays).toBe(7);
    expect(res.body.forecastPeriod).toBe('quarter');
    expect(res.body.forecastDays).toBe(90);
    expect(res.body.windowSpentUsdc).toBe('10.0000000');
    // dailyRunRate = round(100_000_000 / 7) = 14_285_714 units -> '1.4285714'
    expect(res.body.dailyRunRateUsdc).toBe('1.4285714');
    // forecasted = round(100_000_000 * 90 / 7) = 1_285_714_286 units -> '128.5714286'
    expect(res.body.forecastedAmountUsdc).toBe('128.5714286');
    expect(res.body.totalCalls).toBe(1);
  });

  // Scenario 7: Same data twice -> identical ETag and 304 response on match
  it('Scenario 7: returns identical ETag for same data and returns 304 on If-None-Match', async () => {
    const { repository, pool } = createPgMemRepository();
    const userId = 'dev-user-etag-stable';

    await repository.create({
      userId,
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 60_0000000n,
      requestId: 'req-etag-1',
      stellarTxHash: 'tx-etag-1',
      createdAt: new Date(Date.now() - 10 * 86_400_000),
    });

    const app = buildApp({ usageEventsRepository: repository, pool });

    const res1 = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader(userId));

    expect(res1.status).toBe(200);
    expect(res1.headers.etag).toBeDefined();
    const etag1 = res1.headers.etag;

    // Second request with same underlying data
    const res2 = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader(userId));

    expect(res2.status).toBe(200);
    const etag2 = res2.headers.etag;
    expect(etag1).toBe(etag2);

    // Conditional request with If-None-Match returns 304 Not Modified
    const res3 = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader(userId))
      .set('If-None-Match', etag1);

    expect(res3.status).toBe(304);
  });

  it('handles period=week and period=day correctly', async () => {
    const { repository, pool } = createPgMemRepository();
    const userId = 'dev-user-periods';

    await repository.create({
      userId,
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 70_0000000n,
      requestId: 'req-week-day',
      stellarTxHash: 'tx-period-1',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const app = buildApp({ usageEventsRepository: repository, pool });

    // Test week (7 days)
    const resWeek = await request(app)
      .get('/api/billing/forecast?lookbackDays=7&period=week')
      .set('Authorization', authHeader(userId));

    expect(resWeek.status).toBe(200);
    expect(resWeek.body.forecastPeriod).toBe('week');
    expect(resWeek.body.forecastDays).toBe(7);
    expect(resWeek.body.windowSpentUsdc).toBe('70.0000000');
    expect(resWeek.body.dailyRunRateUsdc).toBe('10.0000000');
    expect(resWeek.body.forecastedAmountUsdc).toBe('70.0000000');

    // Test day (1 day)
    const resDay = await request(app)
      .get('/api/billing/forecast?lookbackDays=7&period=day')
      .set('Authorization', authHeader(userId));

    expect(resDay.status).toBe(200);
    expect(resDay.body.forecastPeriod).toBe('day');
    expect(resDay.body.forecastDays).toBe(1);
    expect(resDay.body.dailyRunRateUsdc).toBe('10.0000000');
    expect(resDay.body.forecastedAmountUsdc).toBe('10.0000000');
  });

  it('rejects invalid lookbackDays (e.g. 0, > 90, or non-integer)', async () => {
    const app = buildApp();

    const res1 = await request(app)
      .get('/api/billing/forecast?lookbackDays=0')
      .set('Authorization', authHeader('dev-user-val'));
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .get('/api/billing/forecast?lookbackDays=91')
      .set('Authorization', authHeader('dev-user-val'));
    expect(res2.status).toBe(400);

    const res3 = await request(app)
      .get('/api/billing/forecast?lookbackDays=invalid')
      .set('Authorization', authHeader('dev-user-val'));
    expect(res3.status).toBe(400);
  });

  it('rejects invalid period enum', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/billing/forecast?period=decade')
      .set('Authorization', authHeader('dev-user-val'));

    expect(res.status).toBe(400);
  });

  it('returns 503 when no repository or database pool is configured', async () => {
    const app = buildApp(); // no pool, no repo
    const res = await request(app)
      .get('/api/billing/forecast')
      .set('Authorization', authHeader('dev-user-nopool'));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FORECAST_DATA_UNAVAILABLE');
  });
});
