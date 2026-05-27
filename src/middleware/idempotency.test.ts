import type { Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware, calculateRequestHash } from './idempotency.js';

describe('idempotencyMiddleware — unit', () => {
  let req: Partial<Request>;
  let res: any;
  let next: jest.Mock<NextFunction>;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
    };
    req = {
      header: jest.fn().mockImplementation((name: string) => {
        if (name.toLowerCase() === 'idempotency-key') {
          return 'test-key-123';
        }
        return undefined;
      }),
      body: {
        amountUsdc: '1.00',
        apiId: 'api-1',
      },
      method: 'POST',
      path: '/api/billing/deduct',
      app: {
        locals: {
          dbPool: mockDb,
        },
      } as any,
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      locals: {
        authenticatedUser: { id: 'user-1' },
      },
      statusCode: 200,
    };

    next = jest.fn();
  });

  it('skips if no idempotency key is provided', async () => {
    req.header = jest.fn().mockReturnValue(undefined);
    req.body = {};

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('deletes expired keys and inserts started record for new key', async () => {
    mockDb.query.mockResolvedValue({ rows: [] });

    await idempotencyMiddleware(req as Request, res as Response, next);

    // Should delete expired keys
    expect(mockDb.query).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp OR expires_at < $1',
      expect.any(Array)
    );

    // Should look up the key
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT request_hash'),
      ['test-key-123']
    );

    // Should insert started status
    expect(mockDb.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO idempotency_store'),
      ['test-key-123', expect.any(String), 'started', expect.any(String)]
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('replays response if key is completed and hash matches', async () => {
    const hash = calculateRequestHash('user-1', req.body, 'POST', '/api/billing/deduct');
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // delete call
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          request_hash: hash,
          status: 'completed',
          response_status: 200,
          response_body: JSON.stringify({ success: true, txHash: 'tx-123' }),
          expires_at: new Date(Date.now() + 60000),
        },
      ],
    });

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith('Idempotent-Replayed', 'true');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, txHash: 'tx-123' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 409 Conflict if payload hash does not match', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // delete call
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          request_hash: 'different-hash',
          status: 'completed',
          response_status: 200,
          response_body: JSON.stringify({ success: true }),
          expires_at: new Date(Date.now() + 60000),
        },
      ],
    });

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'IDEMPOTENCY_CONFLICT',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 409 Conflict if request is in progress (started)', async () => {
    const hash = calculateRequestHash('user-1', req.body, 'POST', '/api/billing/deduct');
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // delete call
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          request_hash: hash,
          status: 'started',
          expires_at: new Date(Date.now() + 60000),
        },
      ],
    });

    await idempotencyMiddleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'IDEMPOTENCY_IN_PROGRESS',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('intercepts res.json/res.send and saves successful response', async () => {
    mockDb.query.mockResolvedValue({ rows: [] });

    await idempotencyMiddleware(req as Request, res as Response, next);

    // Call res.json to trigger interception
    const testResponseBody = { success: true, data: 42 };
    res.statusCode = 200;
    res.json(testResponseBody);

    // Wait a tick for async db query inside interceptor
    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE idempotency_store'),
      ['completed', 200, JSON.stringify(testResponseBody), 'test-key-123']
    );
  });

  it('intercepts and deletes key for server error (>= 500)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] });

    await idempotencyMiddleware(req as Request, res as Response, next);

    res.statusCode = 500;
    res.json({ error: 'Internal Server Error' });

    await new Promise(resolve => process.nextTick(resolve));

    expect(mockDb.query).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM idempotency_store WHERE idempotency_key'),
      ['test-key-123']
    );
  });
});
