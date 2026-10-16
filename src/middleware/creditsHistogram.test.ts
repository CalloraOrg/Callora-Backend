import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import express from 'express';
import request from 'supertest';
import { creditsHistogramMiddleware } from './creditsHistogram.js';
import { creditsDuration, resetCreditsMetrics } from '../metrics/registry.js';

describe('creditsHistogramMiddleware (#1310)', () => {
  beforeEach(() => {
    resetCreditsMetrics();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records once per request with bounded route and status_code labels excluding user IDs or raw paths', async () => {
    const app = express();
    app.get(
      '/api/billing/credits/:developerId',
      creditsHistogramMiddleware,
      (_req, res) => {
        res.status(200).json({ credits: 100 });
      },
    );

    await request(app)
      .get('/api/billing/credits/dev_secret_777?userId=usr_888')
      .set('x-user-id', 'usr_888');

    const metric = await creditsDuration.get();
    const countValues = metric.values.filter((v) => v.metricName?.endsWith('_count'));
    const sumValues = metric.values.filter((v) => v.metricName?.endsWith('_sum'));

    expect(countValues).toHaveLength(1);
    expect(countValues[0].value).toBe(1);
    expect(countValues[0].labels).toEqual({
      route: '/api/billing/credits',
      status_code: '200',
    });
    expect(Object.keys(countValues[0].labels)).toEqual(['route', 'status_code']);
    expect(JSON.stringify(countValues[0].labels)).not.toContain('dev_secret_777');
    expect(JSON.stringify(countValues[0].labels)).not.toContain('usr_888');
    expect(sumValues[0].value).toBeGreaterThanOrEqual(0);
  });

  it('clamps duration to non-negative values and observes only once per response finish', async () => {
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(400);

    const req = { aborted: false } as unknown as express.Request;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 402,
    }) as unknown as express.Response;
    const next = jest.fn();

    creditsHistogramMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.emit('finish');
    res.emit('finish');

    const metric = await creditsDuration.get();
    const countValues = metric.values.filter((v) => v.metricName?.endsWith('_count'));
    const sumValues = metric.values.filter((v) => v.metricName?.endsWith('_sum'));

    expect(countValues).toHaveLength(1);
    expect(countValues[0].value).toBe(1);
    expect(countValues[0].labels).toEqual({
      route: '/api/billing/credits',
      status_code: '402',
    });
    expect(sumValues[0].value).toBe(0);
  });

  it('explicitly skips aborted requests', async () => {
    const req = { aborted: true } as unknown as express.Request;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
    }) as unknown as express.Response;
    const next = jest.fn();

    creditsHistogramMiddleware(req, res, next);
    res.emit('finish');

    const metric = await creditsDuration.get();
    expect(metric.values).toHaveLength(0);
  });
});
