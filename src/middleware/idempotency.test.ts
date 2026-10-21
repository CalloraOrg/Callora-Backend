import type { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { newDb, DataType } from 'pg-mem';
import { logger } from '../logger.js';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  idempotencyMiddleware,
  createIdempotencyMiddleware,
  type IdempotencyLease,
  calculateRequestHash,
  IDEMPOTENCY_KEY_REUSE_MISMATCH,
  INVALID_IDEMPOTENCY_KEY,
  isCacheableIdempotencyResponse,
  type IdempotencyConfig,
} from './idempotency.js';
import { errorEnvelopeSchema } from './envelope.js';

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

function makeRes(userId = 'user-1'): Partial<Response> & { locals: { authenticatedUser: { id: string } }; statusCode: number; setHeader: jest.Mock; getHeader: jest.Mock; json: jest.Mock; send: jest.Mock } {
  return {
    once: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    getHeader: jest.fn(),
    locals: { authenticatedUser: { id: userId } },
    statusCode: 200,
  };
}

/** PostgreSQL-semantics store: migrations run as written, NOW() driven by `clock`. */
async function createIdempotencyPool(clock: () => Date): Promise<Pool> {
  const memory = newDb();
  // pg-mem lacks PostgreSQL's timestamp formatting function. Only presentation
  // is supplied here; ownership comparisons and mutations run as SQL.
  memory.public.registerFunction({ name: 'to_char', args: [DataType.timestamp, DataType.text], returns: DataType.text,
    implementation: (value: Date) => value.toISOString().replace('T', ' ').replace('Z', '000') });

  memory.getSchema('pg_catalog').registerFunction({ name: 'now', args: [], returns: DataType.timestamptz, impure: true, implementation: clock }, true);
  const adapter = memory.adapters.createPg();
  const db: Pool = new adapter.Pool();
  await db.query(readFileSync('migrations/004_create_idempotency_store.sql', 'utf8'));
  await db.query(readFileSync('migrations/0025_idempotency_store_scope.sql', 'utf8'));
  await db.query(readFileSync('migrations/0027_idempotency_lease.sql', 'utf8'));
  await db.query(readFileSync('migrations/0028_idempotency_response_headers.sql', 'utf8'));
  return db;
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
    expect(errorEnvelopeSchema.safeParse(res.json.mock.calls[0][0]).success).toBe(true);
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

    const responseBody = res.json.mock.calls[0][0];
    expect(errorEnvelopeSchema.safeParse(responseBody).success).toBe(true);
    expect(responseBody.error.details).toEqual(expect.arrayContaining([
      { field: 'idempotencyKey', message: 'test-key-123', code: IDEMPOTENCY_KEY_REUSE_MISMATCH },
      { field: 'incomingPayloadFingerprint', message: expectedIncoming, code: IDEMPOTENCY_KEY_REUSE_MISMATCH },
      { field: 'storedPayloadFingerprint', message: 'stored-hash-abc', code: IDEMPOTENCY_KEY_REUSE_MISMATCH },
    ]));
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
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.error.details.slice(-3)).toEqual([
      { field: 'incomingFields', message: 'aaa', code: IDEMPOTENCY_KEY_REUSE_MISMATCH },
      { field: 'incomingFields', message: 'mmm', code: IDEMPOTENCY_KEY_REUSE_MISMATCH },
      { field: 'incomingFields', message: 'zzz', code: IDEMPOTENCY_KEY_REUSE_MISMATCH },
    ]);
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
    db = await createIdempotencyPool(() => now);
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

  it('does not cache a response above the body cap, deletes the row and warns with route and size', async () => {
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handler = jest.fn((_req: Request, res: Response) => { res.write('x'.repeat(256 * 1024)); res.end('overflow'); });
    const server = app(handler);
    expect((await post(server)).status).toBe(200);
    await flush();
    expect(await row()).toBeUndefined();
    expect((await post(server)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith('[idempotency] response exceeds cache body limit', {
      route: '/api/billing/deduct',
      bodyBytes: 256 * 1024 + 'overflow'.length,
      maxBodyBytes: 256 * 1024,
    });
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

  it('preserves per-user scoping, cacheable 4xx replay and 5xx retry behavior', async () => {
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

// ---------------------------------------------------------------------------
// Response cache policy over real Express and the same PostgreSQL-semantics store
// ---------------------------------------------------------------------------

async function createHttpIdempotencyApp(handler: RequestHandler, options?: IdempotencyConfig) {
  const pool = await createIdempotencyPool(() => new Date());
  const app = express();
  app.locals.dbPool = pool;
  app.use(express.json());
  app.post('/operation', createIdempotencyMiddleware(options), handler);
  return { app, pool };
}

async function postOperation(app: express.Express, key: string) {
  const response = await request(app).post('/operation').set('Idempotency-Key', key).send({});
  // The finish-time save runs after the response is flushed; let it settle before a retry reads the store.
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

describe('idempotency response cache policy over HTTP', () => {
  it('replays original response headers without persisting cookies', async () => {
    let operations = 0;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.status(201)
        .set('Location', '/resources/created-1')
        .set('ETag', '"resource-v1"')
        .set('Retry-After', '7')
        .set('X-Request-ID', 'request-original')
        .set('Set-Cookie', 'session=synthetic-private-cookie')
        .json({ id: 'created-1' });
    });
    try {
      const original = await postOperation(app, 'headers');
      const replay = await postOperation(app, 'headers');
      expect(original.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(original.body);
      expect(replay.headers.location).toBe('/resources/created-1');
      expect(replay.headers.etag).toBe('"resource-v1"');
      expect(replay.headers['retry-after']).toBe('7');
      expect(replay.headers['x-request-id']).toBe('request-original');
      expect(replay.headers['content-type']).toBe(original.headers['content-type']);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect(operations).toBe(1);
      const stored = await pool.query('SELECT response_headers FROM idempotency_store');
      expect(stored.rows[0].response_headers).toEqual({
        'content-type': original.headers['content-type'],
        location: '/resources/created-1',
        etag: '"resource-v1"',
        'retry-after': '7',
        'x-request-id': 'request-original',
      });
    } finally {
      await pool.end();
    }
  });

  it('replays compressed JSON with its encoding instead of corrupting the response', async () => {
    let operations = 0;
    const payload = { id: 'compressed-resource' };
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.status(201).type('application/json').set('Content-Encoding', 'gzip')
        .send(gzipSync(JSON.stringify(payload)));
    });
    try {
      const original = await postOperation(app, 'encoded-response');
      const replay = await postOperation(app, 'encoded-response');
      expect(original.body).toEqual(payload);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(payload);
      expect(replay.headers['content-encoding']).toBe('gzip');
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(operations).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('does not cache compressed transient JSON (%s)', async (encoding, compress) => {
    let operations = 0;
    let pending = true;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      if (pending) {
        res.status(409).type('application/json').set('Content-Encoding', encoding)
          .send(compress(JSON.stringify({ error: { code: 'RECONCILIATION_REQUIRED' } })));
      } else {
        res.json({ resolved: true });
      }
    });
    try {
      expect((await postOperation(app, 'compressed-transient')).status).toBe(409);
      pending = false;
      const retry = await postOperation(app, 'compressed-transient');
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ resolved: true });
      expect(operations).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('bounds decoded policy inspection instead of retaining a compressed oversized response', async () => {
    let operations = 0;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.type('application/json').set('Content-Encoding', 'gzip')
        .send(gzipSync(JSON.stringify({ payload: 'x'.repeat(256 * 1024) })));
    });
    try {
      await postOperation(app, 'compressed-oversized');
      const stored = await pool.query('SELECT idempotency_key FROM idempotency_store');
      expect(stored.rows).toEqual([]);
      await postOperation(app, 'compressed-oversized');
      expect(operations).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('does not cache a UTF-8 response above the body cap and logs only bounded metadata', async () => {
    const warning = jest.spyOn(logger, 'warn');
    let operations = 0;
    const response = 'é'.repeat(128 * 1024);
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.json(response);
    });
    try {
      const original = await postOperation(app, 'large-body');
      const retry = await postOperation(app, 'large-body');
      expect(original.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.body).toBe(response);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(operations).toBe(2);
      expect(warning).toHaveBeenCalled();
      for (const [, metadata] of warning.mock.calls) {
        expect(metadata).toEqual({
          route: '/operation',
          bodyBytes: 262146,
          maxBodyBytes: 262144,
        });
      }
    } finally {
      warning.mockRestore();
      await pool.end();
    }
  });

  it('allows a retry after a rate-limit response clears', async () => {
    let limited = true;
    let operations = 0;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      if (limited) res.status(429).set('Retry-After', '3').json({ code: 'RATE_LIMITED' });
      else res.json({ accepted: true });
    });
    try {
      const limitedResponse = await postOperation(app, 'rate-limit');
      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.headers['retry-after']).toBe('3');
      limited = false;
      const retry = await postOperation(app, 'rate-limit');
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ accepted: true });
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      expect(operations).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('retries a nested reconciliation envelope until the deduction resolves, then replays it', async () => {
    let resolved = false;
    let operations = 0;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      if (resolved) res.json({ success: true, operations });
      else res.status(409).json({ success: false, error: { code: 'RECONCILIATION_REQUIRED', message: 'pending' } });
    });
    try {
      expect((await postOperation(app, 'reconcile')).status).toBe(409);
      resolved = true;
      const settled = await postOperation(app, 'reconcile');
      expect(settled.status).toBe(200);
      expect(settled.headers['idempotent-replayed']).toBeUndefined();
      const replay = await postOperation(app, 'reconcile');
      expect(replay.body).toEqual({ success: true, operations: 2 });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(operations).toBe(2);
    } finally {
      await pool.end();
    }
  });

  it('replays deterministic validation failures without running the operation twice', async () => {
    let operations = 0;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.status(422).json({ code: 'INVALID_AMOUNT' });
    });
    try {
      const original = await postOperation(app, 'validation');
      const replay = await postOperation(app, 'validation');
      expect(original.status).toBe(422);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ code: 'INVALID_AMOUNT' });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(operations).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('replays pre-migration rows with null headers, including envelope headers from earlier deployments', async () => {
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      res.sendStatus(500);
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const requestHash = calculateRequestHash(undefined, {}, 'POST', '/operation');
    try {
      await pool.query(
        `INSERT INTO idempotency_store
         (scope, idempotency_key, request_hash, status, response_status, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['anonymous', 'legacy', requestHash, 'completed', 200, JSON.stringify({ legacy: 'original' }), expiresAt]
      );
      const replay = await postOperation(app, 'legacy');
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ legacy: 'original' });
      expect(replay.headers['idempotent-replayed']).toBe('true');

      const envelope = 'idempotency-response-v1\n' + JSON.stringify({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Buffer.from('envelope original').toString('base64'),
      });
      await pool.query(
        `INSERT INTO idempotency_store
         (scope, idempotency_key, request_hash, status, response_status, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['anonymous', 'legacy-envelope', requestHash, 'completed', 201, envelope, expiresAt]
      );
      const envelopeReplay = await postOperation(app, 'legacy-envelope');
      expect(envelopeReplay.status).toBe(201);
      expect(envelopeReplay.text).toBe('envelope original');
      expect(envelopeReplay.headers['content-type']).toBe('text/plain; charset=utf-8');
    } finally {
      await pool.end();
    }
  });

  it('never re-runs a pre-1499 hash-only row whose response was not stored', async () => {
    let operations = 0;
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.sendStatus(500);
    });
    try {
      await pool.query(
        `INSERT INTO idempotency_store
         (scope, idempotency_key, request_hash, status, response_status, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['anonymous', 'hash-only', calculateRequestHash(undefined, {}, 'POST', '/operation'), 'completed', 200,
          'idempotency-response-v1\n' + JSON.stringify({ bytes: 1, sha256: 'a'.repeat(64) }),
          new Date(Date.now() + 60_000).toISOString()]
      );
      const replay = await postOperation(app, 'hash-only');
      expect(replay.status).toBe(409);
      expect(replay.body.error.code).toBe('IDEMPOTENCY_RESPONSE_TOO_LARGE');
      expect(errorEnvelopeSchema.safeParse(replay.body).success).toBe(true);
      expect(replay.body.error.details).toEqual([
        { field: 'bytes', message: '1', code: 'IDEMPOTENCY_RESPONSE_TOO_LARGE' },
        { field: 'sha256', message: 'a'.repeat(64), code: 'IDEMPOTENCY_RESPONSE_TOO_LARGE' },
      ]);
      expect(operations).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it.each([[200, false], [418, true], [429, false]] as const)(
    'applies a custom status policy to %i without overriding transient exclusions',
    async (status, cached) => {
      let operations = 0;
      const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
        operations += 1;
        res.status(status).json({ operation: operations });
      }, { cacheableStatus: candidate => candidate === 418 || candidate === 429 });
      try {
        await postOperation(app, 'custom');
        const retry = await postOperation(app, 'custom');
        expect(retry.status).toBe(status);
        expect(retry.body).toEqual({ operation: cached ? 1 : 2 });
        expect(retry.headers['idempotent-replayed']).toBe(cached ? 'true' : undefined);
        expect(operations).toBe(cached ? 1 : 2);
      } finally {
        await pool.end();
      }
    }
  );

  it('caches a JSON response exactly at the 256 KiB byte boundary', async () => {
    let operations = 0;
    const response = 'x'.repeat(262142);
    const { app, pool } = await createHttpIdempotencyApp((_req, res) => {
      operations += 1;
      res.json(response);
    });
    try {
      await postOperation(app, 'at-cap');
      const replay = await postOperation(app, 'at-cap');
      expect(replay.status).toBe(200);
      expect(replay.body).toBe(response);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(operations).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe('exported idempotency cache policy', () => {
  it('matches the documented default status table', () => {
    const cases: [number, boolean][] = [
      [200, true], [201, true], [204, true], [299, true],
      [300, false], [302, false], [399, false],
      [400, true], [401, true], [402, false], [403, true], [404, true], [405, false],
      [408, false], [409, true], [410, true], [422, true], [425, false], [429, false],
      [500, false], [503, false], [504, false],
    ];
    for (const [status, expected] of cases) {
      expect(isCacheableIdempotencyResponse(status, {})).toBe(expected);
    }
  });

  it('never caches transient body codes in either response envelope', () => {
    for (const code of ['RECONCILIATION_REQUIRED', 'IDEMPOTENCY_IN_PROGRESS']) {
      for (const body of [{ code }, { error: { code } }]) {
        expect(isCacheableIdempotencyResponse(200, body)).toBe(false);
        expect(isCacheableIdempotencyResponse(409, body, () => true)).toBe(false);
      }
    }
  });
});
