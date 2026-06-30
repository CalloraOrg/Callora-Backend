import type { Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware, calculateRequestHash, IDEMPOTENCY_KEY_REUSE_MISMATCH } from './idempotency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(rows: Record<string, unknown>[] = []) {
  const mock = { query: jest.fn() };
  // First call: DELETE expired keys
  mock.query.mockResolvedValueOnce({ rows: [] });
  // Second call: SELECT existing key
  mock.query.mockResolvedValueOnce({ rows });
  // All subsequent calls (INSERT / UPDATE / DELETE): succeed
  mock.query.mockResolvedValue({ rows: [] });
  return mock;
}

function makeReq(overrides: Partial<{
  body: Record<string, unknown>;
  idempotencyKeyHeader: string | undefined;
}> = {}): Partial<Request> {
  const { body = { amountUsdc: '1.00', apiId: 'api-1' }, idempotencyKeyHeader = 'test-key-123' } = overrides;
  return {
    header: jest.fn().mockImplementation((name: string) => {
      if (name.toLowerCase() === 'idempotency-key') return idempotencyKeyHeader;
      return undefined;
    }),
    body,
    method: 'POST',
    path: '/api/billing/deduct',
    app: { locals: { dbPool: undefined } } as any, // overridden per test
  };
}

function makeRes(userId = 'user-1'): any {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
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
});

// ---------------------------------------------------------------------------
// idempotencyMiddleware — core flow
// ---------------------------------------------------------------------------

describe('idempotencyMiddleware — unit', () => {
  it('skips if no idempotency key is provided', async () => {
    const mockDb = makeDb();
    const req = makeReq({ idempotencyKeyHeader: undefined }) as Request;
    (req as any).body = {};
    const res = makeRes();
    const next = jest.fn();
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('skips if idempotency key is whitespace only', async () => {
    const mockDb = makeDb();
    const req = makeReq({ idempotencyKeyHeader: '   ' }) as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('deletes expired keys and inserts started record for new key', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(mockDb.query).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp OR expires_at < $1',
      expect.any(Array)
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT request_hash'),
      ['test-key-123']
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO idempotency_store'),
      ['test-key-123', expect.any(String), 'started', expect.any(String)]
    );
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
    (req as any).app = { locals: { dbPool: mockDb } };

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
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: IDEMPOTENCY_KEY_REUSE_MISMATCH })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('response includes conflictingSummary with incomingPayloadFingerprint and storedPayloadFingerprint', async () => {
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
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    const responseBody = (res.json as jest.Mock).mock.calls[0][0];
    expect(responseBody.conflictingSummary).toMatchObject({
      idempotencyKey: 'test-key-123',
      incomingPayloadFingerprint: expectedIncoming,
      storedPayloadFingerprint: 'stored-hash-abc',
    });
  });

  it('conflictingSummary.incomingFields lists top-level body keys (sorted)', async () => {
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
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    const responseBody = (res.json as jest.Mock).mock.calls[0][0];
    expect(responseBody.conflictingSummary.incomingFields).toEqual(['aaa', 'mmm', 'zzz']);
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
    (req as any).app = { locals: { dbPool: mockDb } };

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
    (req as any).app = { locals: { dbPool: mockDb } };

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
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    // Mismatch check runs before status check — should be REUSE_MISMATCH not IN_PROGRESS
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: IDEMPOTENCY_KEY_REUSE_MISMATCH })
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
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('saves successful response via res.json interception', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    res.statusCode = 200;
    res.json({ success: true, data: 42 });

    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE idempotency_store'),
      ['completed', 200, JSON.stringify({ success: true, data: 42 }), 'test-key-123']
    );
  });

  it('deletes key on server error (>= 500) so client can retry', async () => {
    const mockDb = makeDb([]);
    const req = makeReq() as Request;
    const res = makeRes();
    const next = jest.fn();
    (req as any).app = { locals: { dbPool: mockDb } };

    await idempotencyMiddleware(req, res as Response, next as unknown as NextFunction);

    res.statusCode = 500;
    res.json({ error: 'Internal Server Error' });

    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM idempotency_store WHERE idempotency_key'),
      ['test-key-123']
    );
  });
});

// Keep next defined at module scope for use in the describe blocks above
const next = jest.fn();
