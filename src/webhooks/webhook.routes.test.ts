import express from 'express';
import request from 'supertest';

import webhookRouter from './webhook.routes.js';
import { WebhookStore } from './webhook.store.js';
import { errorHandler } from '../middleware/errorHandler.js';

function createTestApp() {
  const app = express();
  app.use('/api/webhooks', webhookRouter);
  app.use(errorHandler);
  return app;
}

describe('webhook management retry policy routes', () => {
  const app = createTestApp();

  it('registers a webhook with a per-subscription retry policy override', async () => {
    const response = await request(app)
      .post('/api/webhooks')
      .send({
        developerId: 'dev-retry-create',
        url: 'http://localhost:3001/webhook',
        events: ['new_api_call'],
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 250,
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.retryPolicy).toEqual({
      maxAttempts: 2,
      baseDelayMs: 250,
    });
    expect(WebhookStore.get('dev-retry-create')?.retryPolicy).toEqual({
      maxAttempts: 2,
      baseDelayMs: 250,
    });
  });

  it('updates an existing webhook retry policy without changing unrelated subscription fields', async () => {
    WebhookStore.register({
      developerId: 'dev-retry-update',
      url: 'http://localhost:3001/old-webhook',
      events: ['new_api_call'],
      secret_current: 'existing-secret',
      createdAt: new Date('2026-06-27T12:00:00.000Z'),
    });

    const response = await request(app)
      .patch('/api/webhooks/dev-retry-update')
      .send({
        retryPolicy: {
          maxAttempts: 3,
          maxDelayMs: 5000,
          backoffMultiplier: 1.5,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      developerId: 'dev-retry-update',
      url: 'http://localhost:3001/old-webhook',
      events: ['new_api_call'],
      retryPolicy: {
        maxAttempts: 3,
        maxDelayMs: 5000,
        backoffMultiplier: 1.5,
      },
    });
    expect(response.body.secret).toBeUndefined();
    expect(response.body.secret_current).toBeUndefined();
    expect(WebhookStore.get('dev-retry-update')?.secret_current).toBe('existing-secret');
  });

  it('returns the standard error envelope for invalid retry policy overrides', async () => {
    const response = await request(app)
      .post('/api/webhooks')
      .send({
        developerId: 'dev-retry-invalid',
        url: 'http://localhost:3001/webhook',
        events: ['new_api_call'],
        retryPolicy: {
          maxAttempts: 0,
        },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_WEBHOOK_RETRY_POLICY');
  });
});
