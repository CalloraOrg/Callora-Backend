import assert from 'node:assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';

import {
  computeSignature,
  safeCompare,
  matchesAnySecret,
  verifyWebhookSignature,
  captureRawBody,
  parseCapturedJson,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  SIGNATURE_TOLERANCE_MS,
} from './webhook.signature.js';
import { WebhookStore } from './webhook.store.js';
import { WebhookNonceStore } from './webhook.nonceStore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeNonce(label = 'test'): string {
  return `nonce-${label}-0123456789ab`;
}

/** Minimal Request stub — only the fields our middleware touches. */
function makeReq(
  overrides: Partial<{
    headers: Record<string, string>;
    webhookSecret: string;
    webhookSecrets: string[];
    webhookNonceScope: string;
    rawBody: Buffer;
    params: Record<string, string>;
  }> = {}
): Request & {
  webhookSecret?: string;
  webhookSecrets?: string[];
  webhookNonceScope?: string;
  rawBody?: Buffer;
  params: Record<string, string>;
} {
  const emitter = new EventEmitter() as unknown as Request & {
    webhookSecret?: string;
    webhookSecrets?: string[];
    webhookNonceScope?: string;
    rawBody?: Buffer;
    headers: Record<string, string>;
    params: Record<string, string>;
  };
  emitter.headers = overrides.headers ?? {};
  emitter.webhookSecret = overrides.webhookSecret;
  emitter.webhookSecrets = overrides.webhookSecrets;
  emitter.webhookNonceScope = overrides.webhookNonceScope;
  emitter.rawBody = overrides.rawBody;
  emitter.params = overrides.params ?? { developerId: 'dev-test' };
  return emitter;
}

function signedHeaders(
  secret: string,
  body: Buffer | string,
  opts: { ts?: string; nonce?: string } = {}
): Record<string, string> {
  const ts = opts.ts ?? makeTimestamp();
  const nonce = opts.nonce ?? makeNonce();
  const sig = computeSignature(secret, ts, body, nonce);
  return {
    [TIMESTAMP_HEADER]: ts,
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: `sha256=${sig}`,
  };
}

/** Minimal Response stub that records status + json calls. */
function makeRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  } as unknown as Response & { _status: number; _body: unknown };
  return res;
}

function collectNextError(
  callback: (next: NextFunction) => void
): { nextCalled: boolean; error: unknown } {
  let nextCalled = false;
  let capturedError: unknown;

  callback((error?: unknown) => {
    nextCalled = true;
    capturedError = error;
  });

  return { nextCalled, error: capturedError };
}

beforeEach(() => {
  WebhookNonceStore.clear();
});

// ---------------------------------------------------------------------------
// computeSignature
// ---------------------------------------------------------------------------

test('computeSignature returns a 64-char hex string', () => {
  const sig = computeSignature('secret', '2026-01-01T00:00:00.000Z', Buffer.from('hello'));
  assert.equal(typeof sig, 'string');
  assert.equal(sig.length, 64);
  assert.match(sig, /^[0-9a-f]+$/);
});

test('computeSignature is deterministic for the same inputs', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const a = computeSignature('secret', ts, Buffer.from('body'));
  const b = computeSignature('secret', ts, Buffer.from('body'));
  assert.equal(a, b);
});

test('computeSignature differs when secret changes', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const a = computeSignature('secret-a', ts, Buffer.from('body'));
  const b = computeSignature('secret-b', ts, Buffer.from('body'));
  assert.notEqual(a, b);
});

test('computeSignature differs when timestamp changes', () => {
  const a = computeSignature('secret', '2026-01-01T00:00:00.000Z', Buffer.from('body'));
  const b = computeSignature('secret', '2026-01-01T00:00:01.000Z', Buffer.from('body'));
  assert.notEqual(a, b);
});

test('computeSignature differs when body changes', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const a = computeSignature('secret', ts, Buffer.from('body-a'));
  const b = computeSignature('secret', ts, Buffer.from('body-b'));
  assert.notEqual(a, b);
});

test('computeSignature accepts a plain string body', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const fromString = computeSignature('secret', ts, 'hello');
  const fromBuffer = computeSignature('secret', ts, Buffer.from('hello'));
  assert.equal(fromString, fromBuffer);
});

test('computeSignature includes nonce in the MAC when provided', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const body = Buffer.from('body');
  const withoutNonce = computeSignature('secret', ts, body);
  const withNonce = computeSignature('secret', ts, body, makeNonce());
  assert.notEqual(withoutNonce, withNonce);
});

test('computeSignature differs when nonce changes', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const body = Buffer.from('body');
  const a = computeSignature('secret', ts, body, makeNonce('a'));
  const b = computeSignature('secret', ts, body, makeNonce('b'));
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// safeCompare
// ---------------------------------------------------------------------------

test('safeCompare returns true for identical hex strings', () => {
  const hex = crypto.randomBytes(32).toString('hex');
  assert.equal(safeCompare(hex, hex), true);
});

test('safeCompare returns false for different hex strings of the same length', () => {
  const a = crypto.randomBytes(32).toString('hex');
  const b = crypto.randomBytes(32).toString('hex');
  // Extremely unlikely to collide
  assert.equal(safeCompare(a, b), false);
});

test('safeCompare returns false when lengths differ', () => {
  const a = 'abcd';
  const b = 'abcdef';
  assert.equal(safeCompare(a, b), false);
});

test('safeCompare returns false for malformed hex with the expected length', () => {
  const a = crypto.randomBytes(32).toString('hex');
  const b = 'z'.repeat(64);
  assert.equal(safeCompare(a, b), false);
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — no-op when secret is absent
// ---------------------------------------------------------------------------

test('verifyWebhookSignature calls next() immediately when no secret is set', (done) => {
  const req = makeReq();           // no webhookSecret
  const res = makeRes();
  const next: NextFunction = () => { done(); };
  verifyWebhookSignature(req, res, next);
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — header validation
// ---------------------------------------------------------------------------

test('verifyWebhookSignature rejects when signature header is missing', () => {
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: { [TIMESTAMP_HEADER]: ts, [NONCE_HEADER]: makeNonce() },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'MISSING_WEBHOOK_SIGNATURE_HEADERS');
});

test('verifyWebhookSignature rejects when timestamp header is missing', () => {
  const req = makeReq({
    webhookSecret: 'secret',
    headers: { [SIGNATURE_HEADER]: 'sha256=abc', [NONCE_HEADER]: makeNonce() },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'MISSING_WEBHOOK_SIGNATURE_HEADERS');
});

test('verifyWebhookSignature rejects when nonce header is missing', () => {
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: 'sha256=abc' },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'MISSING_WEBHOOK_SIGNATURE_HEADERS');
});

test('verifyWebhookSignature rejects a non-ISO timestamp', () => {
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: 'not-a-date',
      [NONCE_HEADER]: makeNonce(),
      [SIGNATURE_HEADER]: 'sha256=abc123',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'BadRequestError');
  assert.equal((error as { code?: string }).code, 'INVALID_WEBHOOK_TIMESTAMP');
});

test('verifyWebhookSignature rejects a stale timestamp (too old)', () => {
  const ts = makeTimestamp(-(SIGNATURE_TOLERANCE_MS + 1000));  // 1 s past window
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: makeNonce(),
      [SIGNATURE_HEADER]: 'sha256=deadbeef',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
});

test('verifyWebhookSignature rejects a future timestamp outside tolerance', () => {
  const ts = makeTimestamp(SIGNATURE_TOLERANCE_MS + 1000);
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: makeNonce(),
      [SIGNATURE_HEADER]: 'sha256=deadbeef',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
});

test('verifyWebhookSignature accepts a timestamp inside the skew window', (done) => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const ts = makeTimestamp(-(SIGNATURE_TOLERANCE_MS - 5_000));
  const headers = signedHeaders('secret', body, { ts });
  const req = makeReq({ webhookSecret: 'secret', headers, rawBody: body });
  verifyWebhookSignature(req, makeRes(), () => { done(); });
});

test('verifyWebhookSignature rejects a malformed signature header (no prefix)', () => {
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: makeNonce(),
      [SIGNATURE_HEADER]: 'badhex',   // missing sha256= prefix
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'BadRequestError');
  assert.equal((error as { code?: string }).code, 'MALFORMED_WEBHOOK_SIGNATURE');
});

test('verifyWebhookSignature rejects a wrong prefix (md5=…)', () => {
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: makeNonce(),
      [SIGNATURE_HEADER]: 'md5=abc123',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'BadRequestError');
  assert.equal((error as { code?: string }).code, 'MALFORMED_WEBHOOK_SIGNATURE');
});

test('verifyWebhookSignature rejects a malformed nonce', () => {
  const body = Buffer.from('{}');
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: 'short',
      [SIGNATURE_HEADER]: `sha256=${computeSignature('secret', ts, body, 'short')}`,
    },
    rawBody: body,
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'BadRequestError');
  assert.equal((error as { code?: string }).code, 'MALFORMED_WEBHOOK_NONCE');
});

test('verifyWebhookSignature rejects a nonce with illegal characters', () => {
  const body = Buffer.from('{}');
  const ts = makeTimestamp();
  const nonce = 'nonce with spaces!!!!';
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: `sha256=${computeSignature('secret', ts, body, nonce)}`,
    },
    rawBody: body,
  });
  const { error } = collectNextError((next) => verifyWebhookSignature(req, makeRes(), next));
  assert.equal((error as { code?: string }).code, 'MALFORMED_WEBHOOK_NONCE');
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — signature mismatch
// ---------------------------------------------------------------------------

test('verifyWebhookSignature rejects when HMAC does not match', () => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const headers = signedHeaders('wrong-secret', body);

  const req = makeReq({
    webhookSecret: 'correct-secret',
    headers,
    rawBody: body,
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'INVALID_WEBHOOK_SIGNATURE');
  assert.equal((error as { message?: string }).message, 'Webhook signature verification failed.');
  assert.doesNotMatch((error as { message?: string }).message ?? '', /current|previous|key/i);
});

test('verifyWebhookSignature rejects when body has been tampered with', () => {
  const originalBody = Buffer.from('{"event":"new_api_call"}');
  const tamperedBody = Buffer.from('{"event":"settlement_completed"}');
  const headers = signedHeaders('secret', originalBody);

  const req = makeReq({
    webhookSecret: 'secret',
    headers,
    rawBody: tamperedBody,
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'INVALID_WEBHOOK_SIGNATURE');
});

test('failure response does not reveal which rotation key was tested', () => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const headers = signedHeaders('attacker-secret', body);
  const req = makeReq({
    webhookSecrets: ['current-secret', 'previous-secret'],
    headers,
    rawBody: body,
  });
  const { error } = collectNextError((next) => verifyWebhookSignature(req, makeRes(), next));
  const serialized = JSON.stringify(error);
  assert.equal((error as { code?: string }).code, 'INVALID_WEBHOOK_SIGNATURE');
  assert.equal((error as { message?: string }).message, 'Webhook signature verification failed.');
  assert.equal(serialized.includes('current-secret'), false);
  assert.equal(serialized.includes('previous-secret'), false);
  assert.equal(serialized.includes('matched'), false);
  assert.equal('matchedKey' in (req as object), false);
  assert.equal('webhookMatchedSecret' in (req as object), false);
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — happy path
// ---------------------------------------------------------------------------

test('verifyWebhookSignature calls next() for a valid signature', (done) => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const req = makeReq({
    webhookSecret: 'my-secret',
    headers: signedHeaders('my-secret', body),
    rawBody: body,
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('verifyWebhookSignature accepts a signature from the current secret when multiple secrets are configured', (done) => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const req = makeReq({
    webhookSecrets: ['current-secret', 'previous-secret'],
    headers: signedHeaders('current-secret', body),
    rawBody: body,
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('verifyWebhookSignature accepts a signature from the unexpired previous secret', (done) => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const req = makeReq({
    webhookSecrets: ['current-secret', 'previous-secret'],
    headers: signedHeaders('previous-secret', body),
    rawBody: body,
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('verifyWebhookSignature rejects a previous secret after its grace window is removed', () => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const req = makeReq({
    webhookSecrets: ['current-secret'],
    headers: signedHeaders('previous-secret', body),
    rawBody: body,
  });
  const res = makeRes();
  const { nextCalled, error } = collectNextError((next) => verifyWebhookSignature(req, res, next));
  assert.equal(nextCalled, true);
  assert.equal((error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((error as { code?: string }).code, 'INVALID_WEBHOOK_SIGNATURE');
  assert.doesNotMatch((error as { message?: string }).message ?? '', /previous/i);
});

test('WebhookStore.getActiveSecrets excludes and deletes the previous secret after previous_expires_at', () => {
  const config = {
    developerId: 'dev-expired',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    secret_current: 'current-secret',
    secret_previous: 'previous-secret',
    previous_expires_at: new Date('2026-06-25T12:00:00.000Z'),
    createdAt: new Date('2026-06-25T11:00:00.000Z'),
  };

  assert.deepEqual(
    WebhookStore.getActiveSecrets(config, new Date('2026-06-25T11:59:59.000Z')),
    ['current-secret', 'previous-secret'],
  );
  assert.deepEqual(
    WebhookStore.getActiveSecrets(config, new Date('2026-06-25T12:00:01.000Z')),
    ['current-secret'],
  );
  assert.equal(config.secret_previous, undefined);
  assert.equal(config.previous_expires_at, undefined);
});

test('verifyWebhookSignature handles empty rawBody gracefully', (done) => {
  const body = Buffer.alloc(0);
  const req = makeReq({
    webhookSecret: 'secret',
    headers: signedHeaders('secret', body),
    rawBody: body,
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('verifyWebhookSignature falls back to empty buffer when rawBody is undefined', (done) => {
  const body = Buffer.alloc(0);
  const req = makeReq({
    webhookSecret: 'secret',
    headers: signedHeaders('secret', body),
    // rawBody intentionally not set
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('matchesAnySecret returns true when any configured key matches', () => {
  const body = Buffer.from('body');
  const ts = makeTimestamp();
  const nonce = makeNonce();
  const received = computeSignature('previous-secret', ts, body, nonce);
  assert.equal(
    matchesAnySecret(['current-secret', 'previous-secret', 'stale-secret'], ts, body, received, nonce),
    true,
  );
  assert.equal(
    matchesAnySecret(['current-secret', 'stale-secret'], ts, body, received, nonce),
    false,
  );
});

test('verifyWebhookSignature rejects a reused nonce as a replay', () => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const headers = signedHeaders('secret', body, { nonce: makeNonce('replay') });
  const first = makeReq({
    webhookSecret: 'secret',
    headers,
    rawBody: body,
    params: { developerId: 'dev-replay' },
  });
  const second = makeReq({
    webhookSecret: 'secret',
    headers,
    rawBody: body,
    params: { developerId: 'dev-replay' },
  });

  const firstPass = collectNextError((next) => verifyWebhookSignature(first, makeRes(), next));
  assert.equal(firstPass.error, undefined);

  const replay = collectNextError((next) => verifyWebhookSignature(second, makeRes(), next));
  assert.equal((replay.error as { name?: string }).name, 'UnauthorizedError');
  assert.equal((replay.error as { code?: string }).code, 'WEBHOOK_NONCE_REPLAYED');
  assert.equal((replay.error as { message?: string }).message, 'Webhook signature verification failed.');
});

test('verifyWebhookSignature does not persist a nonce when the signature is invalid', () => {
  const body = Buffer.from('{"event":"new_api_call"}');
  const nonce = makeNonce('unauth');
  const headers = signedHeaders('wrong-secret', body, { nonce });
  const req = makeReq({
    webhookSecret: 'correct-secret',
    headers,
    rawBody: body,
    params: { developerId: 'dev-unauth' },
  });
  collectNextError((next) => verifyWebhookSignature(req, makeRes(), next));
  assert.equal(WebhookNonceStore.has('dev-unauth', nonce), false);
});

// ---------------------------------------------------------------------------
// captureRawBody
// ---------------------------------------------------------------------------
test('captureRawBody attaches raw bytes to req.rawBody', (done) => {
  const req = makeReq() as Request & { rawBody?: Buffer };
  const res = makeRes();

  captureRawBody(req, res, () => {
    assert.ok(req.rawBody instanceof Buffer);
    assert.equal(req.rawBody.toString(), 'hello world');
    done();
  });

  // Simulate streaming body
  req.emit('data', Buffer.from('hello '));
  req.emit('data', Buffer.from('world'));
  req.emit('end');
});

test('captureRawBody handles empty body', (done) => {
  const req = makeReq() as Request & { rawBody?: Buffer };
  const res = makeRes();

  captureRawBody(req, res, () => {
    assert.ok(req.rawBody instanceof Buffer);
    assert.equal(req.rawBody.length, 0);
    done();
  });

  req.emit('end');
});

test('captureRawBody forwards stream errors to next', (done) => {
  const req = makeReq() as Request & { rawBody?: Buffer };
  const res = makeRes();
  const boom = new Error('stream error');

  captureRawBody(req, res, (err?: unknown) => {
    assert.equal(err, boom);
    done();
  });

  req.emit('error', boom);
});

test('parseCapturedJson populates req.body from rawBody', (done) => {
  const req = makeReq({
    rawBody: Buffer.from('{"event":"new_api_call"}'),
  }) as Request & { rawBody?: Buffer; body?: unknown };
  parseCapturedJson(req, makeRes(), () => {
    assert.deepEqual(req.body, { event: 'new_api_call' });
    done();
  });
});

test('parseCapturedJson rejects invalid JSON', () => {
  const req = makeReq({
    rawBody: Buffer.from('not-json'),
  }) as Request & { rawBody?: Buffer };
  const { error } = collectNextError((next) => parseCapturedJson(req, makeRes(), next));
  assert.equal((error as { code?: string }).code, 'INVALID_BODY');
});
