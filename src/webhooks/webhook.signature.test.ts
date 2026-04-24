import assert from 'node:assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';

import {
  computeSignature,
  safeCompare,
  verifyWebhookSignature,
  captureRawBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  SIGNATURE_TOLERANCE_MS,
} from './webhook.signature.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Minimal Request stub — only the fields our middleware touches. */
function makeReq(
  overrides: Partial<{
    headers: Record<string, string>;
    webhookSecret: string;
    rawBody: Buffer;
  }> = {}
): Request & { webhookSecret?: string; rawBody?: Buffer } {
  const emitter = new EventEmitter() as unknown as Request & {
    webhookSecret?: string;
    rawBody?: Buffer;
    headers: Record<string, string>;
  };
  emitter.headers = overrides.headers ?? {};
  emitter.webhookSecret = overrides.webhookSecret;
  emitter.rawBody = overrides.rawBody;
  return emitter;
}

/** Minimal Response stub that records status + json calls. */
function makeRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  } as unknown as Response & { _status: number; _body: unknown };
  return res;
}

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
    headers: { [TIMESTAMP_HEADER]: ts },   // no SIGNATURE_HEADER
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects when timestamp header is missing', () => {
  const req = makeReq({
    webhookSecret: 'secret',
    headers: { [SIGNATURE_HEADER]: 'sha256=abc' },   // no TIMESTAMP_HEADER
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects a non-ISO timestamp', () => {
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: 'not-a-date',
      [SIGNATURE_HEADER]: 'sha256=abc123',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects a stale timestamp (too old)', () => {
  const ts = makeTimestamp(-(SIGNATURE_TOLERANCE_MS + 1000));  // 1 s past window
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: 'sha256=deadbeef',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects a future timestamp outside tolerance', () => {
  const ts = makeTimestamp(SIGNATURE_TOLERANCE_MS + 1000);
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: 'sha256=deadbeef',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects a malformed signature header (no prefix)', () => {
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: 'badhex',   // missing sha256= prefix
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects a wrong prefix (md5=…)', () => {
  const ts = makeTimestamp();
  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: 'md5=abc123',
    },
    rawBody: Buffer.from('{}'),
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — signature mismatch
// ---------------------------------------------------------------------------

test('verifyWebhookSignature rejects when HMAC does not match', () => {
  const ts = makeTimestamp();
  const body = Buffer.from('{"event":"new_api_call"}');
  const wrongHex = computeSignature('wrong-secret', ts, body);

  const req = makeReq({
    webhookSecret: 'correct-secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: `sha256=${wrongHex}`,
    },
    rawBody: body,
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

test('verifyWebhookSignature rejects when body has been tampered with', () => {
  const ts = makeTimestamp();
  const originalBody = Buffer.from('{"event":"new_api_call"}');
  const tamperedBody = Buffer.from('{"event":"settlement_completed"}');
  const sig = computeSignature('secret', ts, originalBody);

  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: `sha256=${sig}`,
    },
    rawBody: tamperedBody,
  });
  const res = makeRes();
  let nextCalled = false;
  verifyWebhookSignature(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 401);
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — happy path
// ---------------------------------------------------------------------------

test('verifyWebhookSignature calls next() for a valid signature', (done) => {
  const ts = makeTimestamp();
  const body = Buffer.from('{"event":"new_api_call"}');
  const sig = computeSignature('my-secret', ts, body);

  const req = makeReq({
    webhookSecret: 'my-secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: `sha256=${sig}`,
    },
    rawBody: body,
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('verifyWebhookSignature handles empty rawBody gracefully', (done) => {
  const ts = makeTimestamp();
  const body = Buffer.alloc(0);
  const sig = computeSignature('secret', ts, body);

  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: `sha256=${sig}`,
    },
    rawBody: body,
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
});

test('verifyWebhookSignature falls back to empty buffer when rawBody is undefined', (done) => {
  const ts = makeTimestamp();
  const sig = computeSignature('secret', ts, Buffer.alloc(0));

  const req = makeReq({
    webhookSecret: 'secret',
    headers: {
      [TIMESTAMP_HEADER]: ts,
      [SIGNATURE_HEADER]: `sha256=${sig}`,
    },
    // rawBody intentionally not set
  });
  const res = makeRes();
  verifyWebhookSignature(req, res, () => { done(); });
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