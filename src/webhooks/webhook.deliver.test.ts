/**
 * HTTP-level coverage for inbound webhook delivery:
 * rotation window, clock skew, nonce replay, malformed headers, and deletion.
 */

import request from 'supertest';
import express from 'express';
import {
  computeSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  SIGNATURE_TOLERANCE_MS,
} from './webhook.signature.js';
import { WebhookStore } from './webhook.store.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { errorHandler } from '../middleware/errorHandler.js';

jest.mock('../db.js', () => ({
  writeQuery: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock('../logger.js', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    audit: jest.fn(),
  },
  runWithRequestContext: <T>(_ctx: unknown, callback: () => T): T => callback(),
}));

import { createWebhooksRouter } from '../routes/webhooks.js';

function buildApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/webhooks', createWebhooksRouter());
  app.use(errorHandler);
  return app;
}

function nonce(label: string): string {
  return `nonce-${label}-0123456789ab`;
}

function signedHeaders(secret: string, body: string, opts: { ts?: string; nonce?: string } = {}) {
  const ts = opts.ts ?? new Date().toISOString();
  const n = opts.nonce ?? nonce('ok');
  return {
    [TIMESTAMP_HEADER]: ts,
    [NONCE_HEADER]: n,
    [SIGNATURE_HEADER]: `sha256=${computeSignature(secret, ts, body, n)}`,
  };
}

const DELIVER_BODY = JSON.stringify({
  event: 'new_api_call',
  timestamp: '2026-07-27T09:30:00.000Z',
  developerId: 'dev-deliver',
  data: { apiId: 'api-1' },
});

describe('POST /api/webhooks/deliver/:developerId — rotation, skew, replay, deletion', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
    WebhookStore.clear();
    WebhookStore.register({
      developerId: 'dev-deliver',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      secret_current: 'current-secret',
      createdAt: new Date(),
    });
  });

  async function deliver(
    developerId: string,
    headers: Record<string, string>,
    body: string = DELIVER_BODY,
  ) {
    return request(app)
      .post(`/api/webhooks/deliver/${developerId}`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body);
  }

  it('accepts a delivery signed with the current key', async () => {
    const res = await deliver('dev-deliver', signedHeaders('current-secret', DELIVER_BODY, { nonce: nonce('cur') }));
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Webhook delivery accepted.');
  });

  it('accepts both current and previous keys only inside the rotation window', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    WebhookStore.rotateSecret('dev-deliver', 'rotated-secret', expiresAt);
    const stored = WebhookStore.get('dev-deliver')!;

    const previous = await deliver(
      'dev-deliver',
      signedHeaders('current-secret', DELIVER_BODY, { nonce: nonce('prev') }),
    );
    const current = await deliver(
      'dev-deliver',
      signedHeaders('rotated-secret', DELIVER_BODY, { nonce: nonce('new') }),
    );
    expect(previous.status).toBe(200);
    expect(current.status).toBe(200);

    stored.previous_expires_at = new Date(Date.now() - 1);
    const expired = await deliver(
      'dev-deliver',
      signedHeaders('current-secret', DELIVER_BODY, { nonce: nonce('exp') }),
    );
    expect(expired.status).toBe(401);
    expect(expired.body.error?.code ?? expired.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    expect(JSON.stringify(expired.body)).not.toContain('current-secret');
    expect(JSON.stringify(expired.body)).not.toContain('rotated-secret');
    expect(JSON.stringify(expired.body)).not.toMatch(/previous|matched key/i);
  });

  it('rejects timestamps outside the skew window', async () => {
    const stale = new Date(Date.now() - SIGNATURE_TOLERANCE_MS - 2_000).toISOString();
    const future = new Date(Date.now() + SIGNATURE_TOLERANCE_MS + 2_000).toISOString();

    const oldRes = await deliver(
      'dev-deliver',
      signedHeaders('current-secret', DELIVER_BODY, { ts: stale, nonce: nonce('stale') }),
    );
    const futureRes = await deliver(
      'dev-deliver',
      signedHeaders('current-secret', DELIVER_BODY, { ts: future, nonce: nonce('future') }),
    );

    expect(oldRes.status).toBe(401);
    expect(oldRes.body.error?.code ?? oldRes.body.code).toBe('WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
    expect(futureRes.status).toBe(401);
    expect(futureRes.body.error?.code ?? futureRes.body.code).toBe('WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
  });

  it('rejects a reused nonce as a replay', async () => {
    const headers = signedHeaders('current-secret', DELIVER_BODY, { nonce: nonce('replay') });
    const first = await deliver('dev-deliver', headers);
    const second = await deliver('dev-deliver', headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body.error?.code ?? second.body.code).toBe('WEBHOOK_NONCE_REPLAYED');
    expect(second.body.error?.message ?? second.body.message).toBe('Webhook signature verification failed.');
  });

  it('rejects malformed signature and nonce headers', async () => {
    const ts = new Date().toISOString();
    const missingPrefix = await deliver('dev-deliver', {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: nonce('malformed'),
      [SIGNATURE_HEADER]: 'not-a-signature',
    });
    expect(missingPrefix.status).toBe(400);
    expect(missingPrefix.body.error?.code ?? missingPrefix.body.code).toBe('MALFORMED_WEBHOOK_SIGNATURE');

    const badNonce = await deliver('dev-deliver', {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: 'bad nonce!!',
      [SIGNATURE_HEADER]: `sha256=${computeSignature('current-secret', ts, DELIVER_BODY, 'bad nonce!!')}`,
    });
    expect(badNonce.status).toBe(400);
    expect(badNonce.body.error?.code ?? badNonce.body.code).toBe('MALFORMED_WEBHOOK_NONCE');

    const missing = await deliver('dev-deliver', {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: 'sha256=abcd',
    });
    expect(missing.status).toBe(401);
    expect(missing.body.error?.code ?? missing.body.code).toBe('MISSING_WEBHOOK_SIGNATURE_HEADERS');
  });

  it('rejects deliveries after the webhook is deleted', async () => {
    const headers = signedHeaders('current-secret', DELIVER_BODY, { nonce: nonce('del') });
    const before = await deliver('dev-deliver', headers);
    expect(before.status).toBe(200);

    await request(app).delete('/api/webhooks/dev-deliver').expect(200);

    const after = await deliver(
      'dev-deliver',
      signedHeaders('current-secret', DELIVER_BODY, { nonce: nonce('after-del') }),
    );
    expect(after.status).toBe(404);
    expect(after.body.error?.code ?? after.body.code).toBe('WEBHOOK_NOT_FOUND');
  });
});
