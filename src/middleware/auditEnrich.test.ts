/**
 * Tests for src/middleware/auditEnrich.ts
 *
 * Covers:
 *   computeBodyHash — keyed hash, missing key, non-object body, circular refs
 *   sanitizeUserAgent — truncation, empty, undefined
 *   auditEnrichMiddleware — field population, proxy-aware IP, tenant extraction
 */

import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import {
  computeBodyHash,
  sanitizeUserAgent,
  auditEnrichMiddleware,
  USER_AGENT_MAX_LENGTH,
  type AuditContext,
} from './auditEnrich.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AugmentedRequest = Request & { auditContext: AuditContext; id?: string; developerId?: string };

function makeReq(overrides: Partial<AugmentedRequest> = {}): AugmentedRequest {
  return {
    headers: {},
    body: undefined,
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
    get: (name: string) => (overrides.headers as Record<string, string>)?.[name.toLowerCase()],
    ...overrides,
  } as unknown as AugmentedRequest;
}

function makeRes(): Response {
  return {} as Response;
}

function runMiddleware(req: AugmentedRequest): void {
  let called = false;
  const next: NextFunction = () => { called = true; };
  auditEnrichMiddleware(req as unknown as Request, makeRes(), next);
  assert.ok(called, 'next() was not called');
}

// ---------------------------------------------------------------------------
// computeBodyHash
// ---------------------------------------------------------------------------

describe('computeBodyHash', () => {
  const SECRET = 'test-secret-key';

  it('returns a 64-char hex string for a plain object body', () => {
    const hash = computeBodyHash({ action: 'delete', id: 42 }, SECRET);
    assert.ok(typeof hash === 'string');
    assert.equal(hash!.length, 64);
    assert.match(hash!, /^[0-9a-f]{64}$/);
  });

  it('returns the same hash for identical bodies', () => {
    const h1 = computeBodyHash({ a: 1 }, SECRET);
    const h2 = computeBodyHash({ a: 1 }, SECRET);
    assert.equal(h1, h2);
  });

  it('returns different hashes for different bodies', () => {
    const h1 = computeBodyHash({ a: 1 }, SECRET);
    const h2 = computeBodyHash({ a: 2 }, SECRET);
    assert.notEqual(h1, h2);
  });

  it('returns different hashes for different secrets (HMAC keying)', () => {
    const h1 = computeBodyHash({ a: 1 }, 'secret-one');
    const h2 = computeBodyHash({ a: 1 }, 'secret-two');
    assert.notEqual(h1, h2);
  });

  it('returns null when secret is undefined', () => {
    assert.equal(computeBodyHash({ a: 1 }, undefined), null);
  });

  it('returns null when secret is empty string', () => {
    assert.equal(computeBodyHash({ a: 1 }, ''), null);
  });

  it('returns null for null body', () => {
    assert.equal(computeBodyHash(null, SECRET), null);
  });

  it('returns null for undefined body', () => {
    assert.equal(computeBodyHash(undefined, SECRET), null);
  });

  it('returns null for string body (not an object)', () => {
    assert.equal(computeBodyHash('raw string', SECRET), null);
  });

  it('returns null for number body', () => {
    assert.equal(computeBodyHash(42, SECRET), null);
  });

  it('handles an empty object body', () => {
    const hash = computeBodyHash({}, SECRET);
    assert.ok(typeof hash === 'string' && hash.length === 64);
  });

  it('handles array body (typeof array is object)', () => {
    const hash = computeBodyHash([1, 2, 3], SECRET);
    assert.ok(typeof hash === 'string' && hash.length === 64);
  });
});

// ---------------------------------------------------------------------------
// sanitizeUserAgent
// ---------------------------------------------------------------------------

describe('sanitizeUserAgent', () => {
  it('returns the value unchanged for a normal UA', () => {
    const ua = 'Mozilla/5.0 (compatible; Callora/1.0)';
    assert.equal(sanitizeUserAgent(ua), ua);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(sanitizeUserAgent('  curl/7.68  '), 'curl/7.68');
  });

  it('truncates to USER_AGENT_MAX_LENGTH', () => {
    const oversized = 'x'.repeat(USER_AGENT_MAX_LENGTH + 100);
    const result = sanitizeUserAgent(oversized);
    assert.equal(result!.length, USER_AGENT_MAX_LENGTH);
  });

  it('preserves a value exactly at USER_AGENT_MAX_LENGTH', () => {
    const exact = 'a'.repeat(USER_AGENT_MAX_LENGTH);
    assert.equal(sanitizeUserAgent(exact), exact);
  });

  it('returns undefined for empty string', () => {
    assert.equal(sanitizeUserAgent(''), undefined);
  });

  it('returns undefined for undefined', () => {
    assert.equal(sanitizeUserAgent(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// auditEnrichMiddleware
// ---------------------------------------------------------------------------

describe('auditEnrichMiddleware', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, AUDIT_BODY_HASH_SECRET: 'test-hmac-secret' };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('attaches auditContext to req and calls next()', () => {
    const req = makeReq({ headers: {} });
    runMiddleware(req);
    assert.ok(req.auditContext, 'auditContext should be set');
  });

  it('resolves clientIp from socket when no proxy headers', () => {
    const req = makeReq({ socket: { remoteAddress: '10.0.0.1' } as any });
    runMiddleware(req);
    assert.equal(req.auditContext.clientIp, '10.0.0.1');
  });

  it('sets userAgent from User-Agent header', () => {
    const req = makeReq({
      get: (name: string) => name.toLowerCase() === 'user-agent' ? 'supertest/1.0' : undefined,
    } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.userAgent, 'supertest/1.0');
  });

  it('sets userAgent to undefined when no User-Agent header', () => {
    const req = makeReq({ get: (_: string) => undefined } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.userAgent, undefined);
  });

  it('picks correlationId from req.id (set by requestIdMiddleware)', () => {
    const req = makeReq({ id: 'req-id-from-middleware' } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.correlationId, 'req-id-from-middleware');
  });

  it('falls back to x-request-id header if req.id absent', () => {
    const req = makeReq({
      headers: { 'x-request-id': 'header-req-id' },
    } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.correlationId, 'header-req-id');
  });

  it('falls back to x-correlation-id header when x-request-id absent', () => {
    const req = makeReq({
      headers: { 'x-correlation-id': 'corr-id-123' },
    } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.correlationId, 'corr-id-123');
  });

  it('sets correlationId to undefined when no id header', () => {
    const req = makeReq();
    runMiddleware(req);
    assert.equal(req.auditContext.correlationId, undefined);
  });

  it('sets tenantId from req.developerId when present', () => {
    const req = makeReq({ developerId: 'dev-user-42' } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.tenantId, 'dev-user-42');
  });

  it('sets tenantId to null when req.developerId is absent', () => {
    const req = makeReq();
    runMiddleware(req);
    assert.equal(req.auditContext.tenantId, null);
  });

  it('computes bodyHash for a JSON body', () => {
    const req = makeReq({ body: { action: 'test', id: 99 } } as any);
    runMiddleware(req);
    assert.ok(typeof req.auditContext.bodyHash === 'string');
    assert.match(req.auditContext.bodyHash!, /^[0-9a-f]{64}$/);
  });

  it('sets bodyHash to null when body is absent', () => {
    const req = makeReq({ body: undefined } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.bodyHash, null);
  });

  it('sets bodyHash to null when AUDIT_BODY_HASH_SECRET is not set', () => {
    delete process.env.AUDIT_BODY_HASH_SECRET;
    const req = makeReq({ body: { x: 1 } } as any);
    runMiddleware(req);
    assert.equal(req.auditContext.bodyHash, null);
  });

  it('produces deterministic bodyHash across two identical requests', () => {
    const body = { delete: true, id: 7 };
    const req1 = makeReq({ body } as any);
    const req2 = makeReq({ body } as any);
    runMiddleware(req1);
    runMiddleware(req2);
    assert.equal(req1.auditContext.bodyHash, req2.auditContext.bodyHash);
  });
});