import type { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { newDb, DataType } from 'pg-mem';
import { logger } from '../logger.js';
import type { Request, Response, NextFunction } from 'express';
import {
  idempotencyMiddleware,
  createIdempotencyMiddleware,
  type IdempotencyLease,
  calculateRequestHash,
  IDEMPOTENCY_KEY_REUSE_MISMATCH,
  INVALID_IDEMPOTENCY_KEY,
} from './idempotency.js';

/** Mirrors DEFAULT_KEY_MAX_LENGTH in idempotency.ts (not exported). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const next = jest.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(rows: Record<string, unknown>[] = []) {
  const mock = { query: jest.fn() };
  // First call: SELECT existing, non-expired key
  mock.query.mockResolvedValueOnce({ rows });
  // All subsequent calls (INSERT / UPDATE / DELETE): succeed
  mock.query.mockResolvedValue({ rows: rows.length ? [] : [{ lease_token: '2026-01-01 00:00:00.123456' }] });
  return mock;
}

function makeReq(overrides: Partial<{
  body: Record<string, unknown>;
  idempotencyKeyHeader: string | undefined;
}> = {}): Partial<Request> {
  const body = 'body' in overrides ? overrides.body : { amountUsdc: '1.00', apiId: 'api-1' };
  const idempotencyKeyHeader = 'idempotencyKeyHeader' in overrides ? overrides.idempotencyKeyHeader : 'test-key-123';
  return {
    header: jest.fn().mockImplementation((name: string) => {
      if (name.toLowerCase() === 'idempotency-key') return idempotencyKeyHeader;
      return undefined;
    }),
    body,
    method: 'POST',
    path: '/api/billing/deduct',
    originalUrl: '/api/billing/deduct',
    id: 'req-idem-test',
    app: { locals: { dbPool: undefined } } as unknown as Request['app'], // overridden per test
  };
}

function makeRes(userId = 'user-1'): Partial<Response> & { locals: { authenticatedUser: { id: string } }; statusCode: number; setHeader: jest.Mock; json: jest.Mock; send: jest.Mock } {
  return {
    once: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    locals: { authenticatedUser: { id: userId } },
    statusCode: 200,
  };
}

// ---------------------------------------------------------------------------
// calculateRequestHash — canonicalization tests
// ---------------------------------------------------------------------------

describe('calculateRequestHash', () => {
  it('produces the same hash regardless of key order in the body', () => {
    const bodyA = { b: 2, a: 1, c: { z: 26, a: 1 } };
    const bodyB = { a: 1, c: { a: 1, z: 26 }, b: 2 };
    const hashA = calculateRequestHash('user-1', bodyA, 'POST', '/path');
    const hashB = calculateRequestHash('user-1', bodyB, 'POST', '/path');
    expect(hashA).toBe(hashB);
  });

  it('produces different hashes for different bodies', () => {
    const h1 = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/path');
    const h2 = calculateRequestHash('user-1', { amount: '2.00' }, 'POST', '/path');
    expect(h1).not.toBe(h2);
  });

  it('excludes idempotencyKey field from hash so the key itself does not affect fingerprint', () => {
    const withKey = calculateRequestHash('user-1', { amount: '1.00', idempotencyKey: 'key-abc' }, 'POST', '/path');
    const withoutKey = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/path');
    expect(withKey).toBe(withoutKey);
  });

  it('produces different hashes for different users', () => {
    const h1 = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/path');
    const h2 = calculateRequestHash('user-2', { amount: '1.00' }, 'POST', '/path');
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different HTTP methods', () => {
    const h1 = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/path');
    const h2 = calculateRequestHash('user-1', { amount: '1.00' }, 'GET', '/path');
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different paths', () => {
    const h1 = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/api/billing/deduct');
    const h2 = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/api/billing/other');
    expect(h1).not.toBe(h2);
  });

  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = calculateRequestHash('user-1', { amount: '1.00' }, 'POST', '/path');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles arrays of objects with differing key orders', () => {
    const bodyA = { items: [{ b: 2, a: 1 }, { d: 4, c: 3 }] };
    const bodyB = { items: [{ a: 1, b: 2 }, { c: 3, d: 4 }] };
    const h1 = calculateRequestHash('user-1', bodyA, 'POST', '/path');
    const h2 = calculateRequestHash('user-1', bodyB, 'POST', '/path');
    expect(h1).toBe(h2);
  });

  it('removes idempotencyKey from nested objects', () => {
    const body = { nested: { idempotencyKey: 'should-ignore', value: 1 } };
    const hash = calculateRequestHash('user-1', body, 'POST', '/path');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles null and primitive values in body', () => {
    const h1 = calculateRequestHash('user-1', null, 'POST', '/path');
    const h2 = calculateRequestHash('user-1', 'string-body', 'POST', '/path');
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h2).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// idempotencyMiddleware — core flow
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — unit', () => {
  it('skips if no idempotency key is provided', async () => {
    const mockDb = makeDb();
    const req = makeReq({ idempotencyKeyHeader: undefined }) as Request;
    (req as unknown as { body: Record<string, unknown> }).body = {};
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('skips if idempotency key is whitespace only', async () => {
    const mockDb = makeDb();
    const req = makeReq({ idempotencyKeyHeader: '   ' }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects overlong keys without accessing the database', async () => {
    const db = makeDb();
    const req = makeReq({ idempotencyKeyHeader: 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) }) as Request;
    req.app = { locals: { dbPool: db } } as unknown as Request['app'];
    const res = makeRes();
    const next = jest.fn();
    await idempotencyMiddleware(req, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects malformed Idempotency-Key values with the standard error envelope', async () => {
    const mockDb = makeDb();
    const req = makeReq({ idempotencyKeyHeader: 'bad key with spaces' }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: INVALID_IDEMPOTENCY_KEY }),
        requestId: 'req-idem-test',
      })
    );
    expect(next).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('ignores methods outside the configured idempotent write methods', async () => {
    const mockDb = makeDb();
    const req = makeReq() as Request;
    (req as unknown as { method: string }).method = 'GET';
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('does not delete on the request path and inserts a new key', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(mockDb.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT request_hash'),
      ['user-1', 'test-key-123']
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO idempotency_store'),
      ['user-1', 'test-key-123', expect.any(String), '86400 seconds', '60 seconds']
    );
    expect(mockDb.query.mock.calls[1][0]).toContain('ON CONFLICT (scope, idempotency_key)');
    expect(mockDb.query.mock.calls[0][0]).toContain('expires_at > NOW()');
    expect(mockDb.query.mock.calls.filter(([text]: [string]) => text.includes('DELETE FROM idempotency_store WHERE expires_at')).length).toBe(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('replays cached response when key exists, is completed, and hash matches', async () => {
    const body = { amountUsdc: '1.00', apiId: 'api-1' };
    const hash = calculateRequestHash('user-1', body, 'POST', '/api/billing/deduct');
    const mockDb = makeDb([{
      request_hash: hash,
      status: 'completed',
      response_status: 200,
      response_body: JSON.stringify({ success: true, txHash: 'tx-123' }),
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const req = makeReq({ body }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, txHash: 'tx-123' });
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mismatch detection — the core of issue #427
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — payload mismatch (issue #427)', () => {
  it('returns 409 with IDEMPOTENCY_KEY_REUSE_MISMATCH when payload differs', async () => {
    const mockDb = makeDb([{
      request_hash: 'completely-different-hash-stored',
      status: 'completed',
      response_status: 200,
      response_body: JSON.stringify({ success: true }),
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const req = makeReq({ body: { amountUsdc: '1.00', apiId: 'api-1' } }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: IDEMPOTENCY_KEY_REUSE_MISMATCH }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('response includes redacted mismatch details with request fingerprints', async () => {
    const mockDb = makeDb([{
      request_hash: 'stored-hash-abc',
      status: 'completed',
      response_status: 200,
      response_body: JSON.stringify({ success: true }),
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const body = { amountUsdc: '2.00', apiId: 'api-2' };
    const expectedIncoming = calculateRequestHash('user-1', body, 'POST', '/api/billing/deduct');
    const req = makeReq({ body }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    const responseBody = (res.json as jest.Mock).mock.calls[0][0];
    expect(responseBody.error.details).toMatchObject({
      idempotencyKey: 'test-key-123',
      incomingPayloadFingerprint: expectedIncoming,
      storedPayloadFingerprint: 'stored-hash-abc',
    });
  });

  it('mismatch details list top-level body keys (sorted)', async () => {
    const mockDb = makeDb([{
      request_hash: 'different-stored',
      status: 'completed',
      response_status: 200,
      response_body: JSON.stringify({ success: true }),
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const body = { zzz: '1', aaa: '2', mmm: '3' };
    const req = makeReq({ body }) as Request;
    const res = makeRes();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    const responseBody = (res.json as jest.Mock).mock.calls[0][0];
    expect(responseBody.error.details.incomingFields).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('does NOT leak stored values — only fingerprints and field names are returned', async () => {
    const mockDb = makeDb([{
      request_hash: 'some-other-hash',
      status: 'completed',
      response_status: 200,
      response_body: JSON.stringify({ success: true, sensitiveData: 'secret-value' }),
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const req = makeReq({ body: { amount: '5.00' } }) as Request;
    const res = makeRes();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    const responseBody = (res.json as jest.Mock).mock.calls[0][0];
    const jsonStr = JSON.stringify(responseBody);
    expect(jsonStr).not.toContain('secret-value');
    expect(jsonStr).not.toContain('sensitiveData');
  });

  it('same payload with different key order still matches (canonicalization)', async () => {
    // Body A and Body B have the same data in different key order
    const bodyA = { apiId: 'api-1', amountUsdc: '1.00' };
    const bodyB = { amountUsdc: '1.00', apiId: 'api-1' };

    // Hash stored with bodyA ordering
    const hashA = calculateRequestHash('user-1', bodyA, 'POST', '/api/billing/deduct');

    // New request arrives with bodyB ordering — should still match (not 409)
    const mockDb = makeDb([{
      request_hash: hashA,
      status: 'completed',
      response_status: 200,
      response_body: JSON.stringify({ success: true }),
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const req = makeReq({ body: bodyB }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    // Should replay, NOT return 409
    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSE_MISMATCH even when stored record is still in "started" state with different hash', async () => {
    const mockDb = makeDb([{
      request_hash: 'started-different-hash',
      status: 'started',
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const req = makeReq({ body: { amountUsdc: '99.00' } }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    // Mismatch check runs before status check — should be REUSE_MISMATCH not IN_PROGRESS
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: IDEMPOTENCY_KEY_REUSE_MISMATCH }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// In-progress and error handling
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — in-progress and error paths', () => {
  it('returns 409 IDEMPOTENCY_IN_PROGRESS when hash matches but status is started', async () => {
    const body = { amountUsdc: '1.00', apiId: 'api-1' };
    const hash = calculateRequestHash('user-1', body, 'POST', '/api/billing/deduct');
    const mockDb = makeDb([{
      request_hash: hash,
      status: 'started',
      expires_at: new Date(Date.now() + 60_000),
    }]);
    const req = makeReq({ body }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

});

describe('idempotency leases and response lifecycle (PostgreSQL semantics)', () => {
  let db: Pool;
  let now: Date;
  const body = { amountUsdc: '1.00', apiId: 'api-1' };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const row = async () => (await db.query('SELECT * FROM idempotency_store')).rows[0];

  beforeEach(async () => {
    now = new Date('2026-01-01T00:00:00Z');
    const memory = newDb();
    // pg-mem lacks PostgreSQL's timestamp formatting function. Only presentation
    // is supplied here; ownership comparisons and mutations run as SQL.
    memory.public.registerFunction({ name: 'to_char', args: [DataType.timestamp, DataType.text], returns: DataType.text,
      implementation: (value: Date) => value.toISOString().replace('T', ' ').replace('Z', '000') });

    memory.getSchema('pg_catalog').registerFunction({ name: 'now', args: [], returns: DataType.timestamptz, impure: true, implementation: () => now }, true);
    const adapter = memory.adapters.createPg();
    db = new adapter.Pool();
    await db.query(readFileSync('migrations/004_create_idempotency_store.sql', 'utf8'));
    await db.query(readFileSync('migrations/0025_idempotency_store_scope.sql', 'utf8'));
    await db.query(readFileSync('migrations/0028_idempotency_lease.sql', 'utf8'));
  });
  afterEach(async () => { jest.restoreAllMocks(); await db.end(); });

  // A writable response double exercises late finishes and transport loss without
  // sleeps or dangling sockets. HTTP cases below additionally use real Express.
  async function invoke(userId = 'user-1', requestBody = body) {
    const req = makeReq({ body: requestBody }) as Request;
    req.app = { locals: { dbPool: db } } as unknown as Request['app'];
    const events = new EventEmitter();
    const headers: Record<string, string> = {};
    const res = Object.assign(events, {
      locals: { authenticatedUser: { id: userId } } as { authenticatedUser: { id: string }; idempotency?: IdempotencyLease },
      statusCode: 200,
      status: jest.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
      setHeader: jest.fn((name: string, value: string) => { headers[name] = value; }),
      getHeader: (name: string) => headers[name],
      write: jest.fn(() => true),
      end: jest.fn(function (this: EventEmitter) { this.emit('finish'); return this; }),
      json: jest.fn(function (this: { end(chunk: string): unknown }, value: unknown) { this.end(JSON.stringify(value)); return this; }),
    });
    const next = jest.fn();
    await idempotencyMiddleware(req, res as unknown as Response, next);
    await flush();
    return { res, next };
  }

  function app(handler: express.RequestHandler) {
    const server = express();
    server.locals.dbPool = db;
    server.use(express.json());
    server.use((_req, res, next) => { res.locals.authenticatedUser = { id: 'user-1' }; next(); });
    server.post('/api/billing/deduct', createIdempotencyMiddleware(), handler);
    return server;
  }
  const post = (server: express.Express) => request(server).post('/api/billing/deduct').set('Idempotency-Key', 'test-key-123').send(body);

  it.each(['204 end', 'sendStatus', 'json', 'send', 'end chunk', 'stream', 'binary'])('captures and replays %s through finish', async (mode) => {
    const handler = jest.fn((_req: Request, res: Response) => {
      if (mode === '204 end') res.status(204).end();
      else if (mode === 'sendStatus') res.sendStatus(202);
      else if (mode === 'json') res.status(201).json({ saved: true });
      else if (mode === 'send') res.send('plain response');
      else if (mode === 'end chunk') res.end('final chunk');
      else if (mode === 'binary') res.type('application/octet-stream').end(Buffer.from([0, 255, 128]));
      else { res.type('text/plain'); res.write('first '); res.end('last'); }
    });
    const server = app(handler);
    const first = await post(server);
    await flush();
    expect((await row()).status).toBe('completed');
    const replay = await post(server);
    expect(replay.status).toBe(first.status);
    expect(replay.text).toBe(first.text);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('releases a disconnected request and immediately executes a retry', async () => {
    const first = await invoke();
    expect(first.next).toHaveBeenCalledWith();
    first.res.emit('close');
    await flush();
    expect(await row()).toBeUndefined();
    const retry = await invoke();
    expect(retry.next).toHaveBeenCalledWith();
  });

  it('takes over a crashed request after expiry exactly once', async () => {
    await invoke();
    now = new Date(now.getTime() + 61_000);
    const attempts = await Promise.all([invoke(), invoke()]);
    expect(attempts.filter(result => result.next.mock.calls.length === 1)).toHaveLength(1);
    expect(attempts.filter(result => result.res.statusCode === 409)).toHaveLength(1);
  });

  it('blocks same-payload retries inside the lease and mismatches even after expiry', async () => {
    await invoke();
    const retry = await invoke();
    expect(retry.next).not.toHaveBeenCalled();
    expect(retry.res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS' }) }));
    now = new Date(now.getTime() + 61_000);
    const mismatch = await invoke('user-1', { ...body, amountUsdc: '2.00' });
    expect(mismatch.next).not.toHaveBeenCalled();
    expect(mismatch.res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: IDEMPOTENCY_KEY_REUSE_MISMATCH }) }));
  });

  it.each(['finish', 'close', '5xx'])('fences the old owner on late %s after takeover', async (mode) => {
    const old = await invoke();
    now = new Date(now.getTime() + 61_000);
    const replacement = await invoke();
    const owned = await row();
    if (mode === 'close') old.res.emit('close');
    else { old.res.statusCode = mode === '5xx' ? 500 : 200; old.res.json({ old: true }); }
    await flush();
    expect(await row()).toEqual(owned);
    replacement.res.json({ replacement: true });
    await flush();
    expect((await row()).status).toBe('completed');
  });

  it('renews the lease and fences a lost owner from renewing', async () => {
    const first = await invoke();
    now = new Date(now.getTime() + 40_000);
    await first.res.locals.idempotency!.renew();
    now = new Date(now.getTime() + 30_000);
    expect((await invoke()).res.statusCode).toBe(409);
    first.res.json({ renewed: true });
    await flush();
    expect((await row()).status).toBe('completed');
    await expect(first.res.locals.idempotency!.renew()).rejects.toThrow('already ended');
  });

  it('rejects renewal after expiry or takeover', async () => {
    const first = await invoke();
    now = new Date(now.getTime() + 61_000);
    await expect(first.res.locals.idempotency!.renew()).rejects.toThrow('ownership lost');
    await invoke();
    await expect(first.res.locals.idempotency!.renew()).rejects.toThrow('ownership lost');
  });

  it('serializes completion behind a pending renewal', async () => {
    const first = await invoke();
    now = new Date(now.getTime() + 40_000);
    const renewal = first.res.locals.idempotency!.renew();
    // Let the renewal enter its SQL statement before the finish event.
    await Promise.resolve();
    first.res.json({ result: true });
    await renewal;
    await flush();
    expect((await row()).status).toBe('completed');
  });

  it('stores only a hash for oversized streaming responses and refuses replay', async () => {
    const handler = jest.fn((_req: Request, res: Response) => { res.write('x'.repeat(256 * 1024)); res.end('overflow'); });
    const server = app(handler);
    expect((await post(server)).status).toBe(200);
    await flush();
    expect((await row()).response_body.length).toBeLessThan(300);
    const retry = await post(server);
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('IDEMPOTENCY_RESPONSE_TOO_LARGE');
    expect(retry.body.error.details.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(retry.body.error.message).toContain('Fetch the resource');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('logs a failed save and releases its lease for an immediate retry', async () => {
    const first = await invoke();
    const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const query = db.query.bind(db);
    jest.spyOn(db, 'query').mockImplementation(((sql: string, params: unknown[]) => {
      if (sql.includes("SET status = 'completed'")) return Promise.reject(new Error('save failed'));
      return query(sql, params);
    }) as typeof db.query);
    first.res.json({ saved: false });
    await flush();
    expect(log).toHaveBeenCalledWith('[idempotency] failed to save response', expect.objectContaining({ err: expect.any(Error) }));
    expect(await row()).toBeUndefined();
    expect((await invoke()).next).toHaveBeenCalledWith();
  });

  it('logs failed disconnect cleanup and leaves only a bounded lease', async () => {
    const first = await invoke();
    const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(db, 'query').mockImplementationOnce(() => Promise.reject(new Error('offline')));
    first.res.emit('close');
    await flush();
    expect(log).toHaveBeenCalled();
    now = new Date(now.getTime() + 61_000);
    expect((await invoke()).next).toHaveBeenCalledWith();
  });

  it('preserves per-user scoping, non-5xx caching and 5xx retry behavior', async () => {
    const first = await invoke('user-a');
    first.res.statusCode = 400;
    first.res.json({ invalid: true });
    await flush();
    expect((await invoke('user-a')).res.statusCode).toBe(400);
    const other = await invoke('user-b');
    expect(other.next).toHaveBeenCalledWith();
    other.res.statusCode = 500;
    other.res.json({ failed: true });
    await flush();
    expect((await invoke('user-b')).next).toHaveBeenCalledWith();
  });

  it('atomically replaces a retention-expired record', async () => {
    const first = await invoke();
    first.res.json({ old: true });
    await flush();
    now = new Date(now.getTime() + 86_401_000);
    expect((await invoke('user-1', { ...body, amountUsdc: '2.00' })).next).toHaveBeenCalledWith();
  });

  it('forwards acquisition database errors without running the handler', async () => {
    jest.spyOn(db, 'query').mockImplementationOnce(() => Promise.reject(new Error('unavailable')));
    const result = await invoke();
    expect(result.next).toHaveBeenCalledWith(expect.objectContaining({ message: 'unavailable' }));
  });
});
