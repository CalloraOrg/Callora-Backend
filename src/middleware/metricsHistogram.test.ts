import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import express from 'express';
import request from 'supertest';
import {
  billingDeductHistogramMiddleware,
  refreshTokenHistogramMiddleware,
  maintenanceHistogramMiddleware,
  adminHistogramMiddleware,
} from './metricsHistogram.js';
import {
  billingDeductDuration,
  refreshTokenDuration,
  maintenanceDuration,
  adminDuration,
  resetBillingDeductMetrics,
  resetRefreshTokenMetrics,
  resetMaintenanceMetrics,
  resetAdminMetrics,
} from '../metrics/registry.js';

describe('metricsHistogram middleware (#1310)', () => {
  beforeEach(() => {
    resetBillingDeductMetrics();
    resetRefreshTokenMetrics();
    resetMaintenanceMetrics();
    resetAdminMetrics();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records exactly one observation per request for billingDeductHistogramMiddleware with bounded labels', async () => {
    const app = express();
    app.post(
      '/api/billing/deduct/:userId',
      billingDeductHistogramMiddleware,
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    await request(app)
      .post('/api/billing/deduct/user-secret-12345')
      .set('x-user-id', 'user-secret-12345')
      .send({ amount: 10 });

    const metric = await billingDeductDuration.get();
    const countValues = metric.values.filter((v) => v.metricName?.endsWith('_count'));
    const sumValues = metric.values.filter((v) => v.metricName?.endsWith('_sum'));

    expect(countValues).toHaveLength(1);
    expect(countValues[0].value).toBe(1);
    expect(countValues[0].labels).toEqual({
      route: '/api/billing/deduct',
      status_code: '200',
    });
    expect(Object.keys(countValues[0].labels)).toEqual(['route', 'status_code']);
    expect(JSON.stringify(countValues[0].labels)).not.toContain('user-secret-12345');
    expect(sumValues[0].value).toBeGreaterThanOrEqual(0);
  });

  it('records bounded route templates on adminHistogramMiddleware and never leaks raw paths or user IDs', async () => {
    const app = express();
    const adminRouter = express.Router();
    adminRouter.use(adminHistogramMiddleware);
    adminRouter.get('/users/:userId/keys/:keyId', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use('/api/admin', adminRouter);

    await request(app).get('/api/admin/users/usr_987654/keys/key_abcdef');
    await request(app).get('/api/admin/unmatched/raw-secret-id-999');

    const metric = await adminDuration.get();
    const countValues = metric.values.filter((v) => v.metricName?.endsWith('_count'));

    expect(countValues).toHaveLength(2);
    const routes = countValues.map((v) => v.labels.route).sort();
    expect(routes).toEqual([
      '/api/admin/:unmatched',
      '/api/admin/users/:userId/keys/:keyId',
    ]);

    for (const v of countValues) {
      expect(Object.keys(v.labels).sort()).toEqual(['route', 'status_code']);
      expect(JSON.stringify(v.labels)).not.toContain('usr_987654');
      expect(JSON.stringify(v.labels)).not.toContain('key_abcdef');
      expect(JSON.stringify(v.labels)).not.toContain('raw-secret-id-999');
    }
  });

  it('records non-negative durations even if performance.now() regresses and observes only once if finish fires twice', async () => {
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(950); // simulated clock skew

    const req = { aborted: false } as unknown as express.Request;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 201,
    }) as unknown as express.Response;
    const next = jest.fn();

    billingDeductHistogramMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.emit('finish');
    res.emit('finish'); // duplicate finish event must be ignored

    const metric = await billingDeductDuration.get();
    const countValues = metric.values.filter((v) => v.metricName?.endsWith('_count'));
    const sumValues = metric.values.filter((v) => v.metricName?.endsWith('_sum'));

    expect(countValues).toHaveLength(1);
    expect(countValues[0].value).toBe(1);
    expect(sumValues[0].value).toBeGreaterThanOrEqual(0);
  });

  it('explicitly skips aborted requests so partial or disconnected calls do not pollute histograms', async () => {
    const req = { aborted: true } as unknown as express.Request;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
    }) as unknown as express.Response;
    const next = jest.fn();

    billingDeductHistogramMiddleware(req, res, next);
    refreshTokenHistogramMiddleware(req, res, next);
    maintenanceHistogramMiddleware(req, res, next);
    adminHistogramMiddleware(req, res, next);

    res.emit('finish');

    expect((await billingDeductDuration.get()).values).toHaveLength(0);
    expect((await refreshTokenDuration.get()).values).toHaveLength(0);
    expect((await maintenanceDuration.get()).values).toHaveLength(0);
    expect((await adminDuration.get()).values).toHaveLength(0);
  });
});
