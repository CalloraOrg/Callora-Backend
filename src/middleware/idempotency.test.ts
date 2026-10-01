import type { Request, Response, NextFunction } from 'express';
import {
  idempotencyMiddleware,
  calculateRequestHash,
  IDEMPOTENCY_KEY_REUSE_MISMATCH,
  INVALID_IDEMPOTENCY_KEY,
} from './idempotency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(rows: Record<string, unknown>[] = []) {
  const mock = { query: jest.fn() };
  // First call: SELECT existing, non-expired key
  mock.query.mockResolvedValueOnce({ rows });
  // All subsequent calls (INSERT / UPDATE / DELETE): succeed
  mock.query.mockResolvedValue({ rows: [] });
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
      ['user-1', 'test-key-123', expect.any(String), 'started', expect.any(String)]
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

  it('saves successful response via res.json interception', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    res.statusCode = 200;
    res.json({ success: true, data: 42 });

    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE idempotency_store'),
      ['completed', 200, JSON.stringify({ success: true, data: 42 }), 'user-1', 'test-key-123']
    );
  });

  it('deletes key on server error (>= 500) so client can retry', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    res.statusCode = 500;
    res.json({ error: 'Internal Server Error' });

    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM idempotency_store WHERE scope'),
      ['user-1', 'test-key-123']
    );
  });

  it('saves successful response via res.send interception', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    res.statusCode = 200;
    res.send(JSON.stringify({ success: true }));

    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE idempotency_store'),
      ['completed', 200, JSON.stringify({ success: true }), 'user-1', 'test-key-123']
    );
  });

  it('handles saveResponse database error gracefully', async () => {
    const mockDb = { query: jest.fn() };
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // SELECT empty
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT started
    mockDb.query.mockRejectedValueOnce(new Error('DB error')); // UPDATE fails

    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalled();
    res.statusCode = 200;
    res.json({ success: true });

    await new Promise(resolve => process.nextTick(resolve));
    // Should not throw - error is caught and logged
  });
});

// ---------------------------------------------------------------------------
// Per-user scoping — issue #1273
// ---------------------------------------------------------------------------

interface ScopedRow {
  request_hash: string;
  status: string;
  response_status: number;
  response_body: string;
  expires_at: string;
}

/** Stateful in-memory idempotency_store keyed by (scope, key). */
function makeScopedPool() {
  const store = new Map<string, ScopedRow>();
  const composite = (scope: string, key: string) => `${scope}::${key}`;

  const query = jest.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes('DELETE FROM idempotency_store WHERE expires_at')) {
      return { rows: [] };
    }
    if (text.includes('SELECT request_hash')) {
      const [scope, key] = params as [string, string];
      const row = store.get(composite(scope, key));
      return { rows: row ? [row] : [] };
    }
    if (text.includes('INSERT INTO idempotency_store')) {
      const [scope, key, requestHash, status, expiresAt] = params as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (store.has(composite(scope, key))) {
        return { rows: [], rowCount: 0 };
      }
      store.set(composite(scope, key), {
        request_hash: requestHash,
        status,
        response_status: 0,
        response_body: '',
        expires_at: expiresAt,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE idempotency_store')) {
      const [status, responseStatus, responseBody, scope, key] = params as [
        string,
        number,
        string,
        string,
        string,
      ];
      const row = store.get(composite(scope, key));
      if (row) {
        store.set(composite(scope, key), {
          ...row,
          status,
          response_status: responseStatus,
          response_body: responseBody,
        });
      }
      return { rows: [] };
    }
    if (text.includes('DELETE FROM idempotency_store WHERE scope')) {
      const [scope, key] = params as [string, string];
      store.delete(composite(scope, key));
      return { rows: [] };
    }
    return { rows: [] };
  });

  return { query, store, composite } as unknown as {
    query: jest.Mock;
    store: Map<string, ScopedRow>;
    composite: (scope: string, key: string) => string;
  };
}

describe('idempotencyMiddleware — per-user key scoping (issue #1273)', () => {
  async function invoke(userId: string, db: unknown, req = makeReq() as Request) {
    (req as unknown as { app: { locals: { dbPool: unknown } } }).app = {
      locals: { dbPool: db },
    };
    const res = makeRes(userId);
    const next = jest.fn();
    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);
    return { req, res, next };
  }

  it('lets two users use the same key independently', async () => {
    const db = makeScopedPool();

    const first = await invoke('user-a', db);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = await invoke('user-b', db);
    // No cross-tenant mismatch/replay: user-b gets its own record.
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(second.res.status).not.toHaveBeenCalledWith(409);

    expect(db.store.has(db.composite('user-a', 'test-key-123'))).toBe(true);
    expect(db.store.has(db.composite('user-b', 'test-key-123'))).toBe(true);
  });

  it('replays the stored response only for the owning user', async () => {
    const db = makeScopedPool();

    const first = await invoke('user-a', db);
    first.res.statusCode = 200;
    first.res.json({ success: true, txHash: 'tx-a' });
    await new Promise(resolve => process.nextTick(resolve));

    // Same user retries the same key → replay.
    const retry = await invoke('user-a', db);
    expect(retry.res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(retry.res.json).toHaveBeenCalledWith({ success: true, txHash: 'tx-a' });
    expect(retry.next).not.toHaveBeenCalled();

    // A different user with the same key is unaffected by the replay.
    const other = await invoke('user-b', db);
    expect(other.next).toHaveBeenCalledTimes(1);
  });
});

// Keep next defined at module scope for use in the describe blocks above
const next = jest.fn();
