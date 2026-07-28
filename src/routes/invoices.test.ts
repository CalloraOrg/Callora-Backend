import express from 'express';
import request from 'supertest';

// Mock the requireAuth middleware to pass a developerId
jest.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).developerId = 'dev-user-123';
    next();
  }
}));

import { createInvoicesRouter } from './invoices.js';
import { errorHandler } from '../middleware/errorHandler.js';
import prisma from '../lib/prisma.js';

// Mock prisma.invoice.findMany
jest.mock('../lib/prisma.js', () => ({
  __esModule: true,
  default: {
    invoice: {
      findMany: jest.fn(),
    }
  }
}));

describe('GET /api/invoices cursor pagination', () => {
  let app: express.Express;
  let findManyMock: jest.Mock;

  beforeEach(() => {
    findManyMock = prisma.invoice.findMany as jest.Mock;
    findManyMock.mockReset();

    app = express();
    app.use(express.json());
    app.use('/api/invoices', createInvoicesRouter());
    app.use(errorHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns paginated data without cursor', async () => {
    const mockInvoices = [
      { id: 'uuid-1', created_at: new Date('2026-07-28T10:00:00Z') },
      { id: 'uuid-2', created_at: new Date('2026-07-28T09:00:00Z') },
    ];
    findManyMock.mockResolvedValue(mockInvoices);

    const res = await request(app).get('/api/invoices?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
    
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      take: 3, // limit + 1
      where: { user_id: 'dev-user-123' },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      cursor: undefined,
    }));
  });

  it('generates nextCursor when hasMore is true', async () => {
    const mockInvoices = [
      { id: 'uuid-1', created_at: new Date('2026-07-28T10:00:00Z') },
      { id: 'uuid-2', created_at: new Date('2026-07-28T09:00:00Z') },
      { id: 'uuid-3', created_at: new Date('2026-07-28T08:00:00Z') },
    ];
    findManyMock.mockResolvedValue(mockInvoices);

    const res = await request(app).get('/api/invoices?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.hasMore).toBe(true);
    
    // decoded cursor should contain the last item of the current page (uuid-2)
    const decodedCursor = JSON.parse(Buffer.from(res.body.meta.nextCursor, 'base64').toString('utf-8'));
    expect(decodedCursor.id).toBe('uuid-2');
    expect(decodedCursor.created_at).toBe('2026-07-28T09:00:00.000Z');
  });

  it('queries using cursor when provided', async () => {
    const cursorData = {
      id: 'uuid-2',
      created_at: '2026-07-28T09:00:00.000Z'
    };
    const cursorBase64 = Buffer.from(JSON.stringify(cursorData)).toString('base64');
    findManyMock.mockResolvedValue([]);

    const res = await request(app).get(`/api/invoices?limit=10&cursor=${cursorBase64}`);

    expect(res.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { id: 'uuid-2' } // Should pass only id to prisma cursor
    }));
  });

  it('rejects invalid cursor format (not base64 json)', async () => {
    const res = await request(app).get(`/api/invoices?limit=10&cursor=invalid_base64`);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid cursor format');
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('rejects valid base64 but invalid schema payload', async () => {
    const cursorData = { id: 'not-a-uuid' }; // missing created_at and invalid uuid
    const cursorBase64 = Buffer.from(JSON.stringify(cursorData)).toString('base64');

    const res = await request(app).get(`/api/invoices?cursor=${cursorBase64}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid cursor format');
  });

  it('rejects invalid limit parameter', async () => {
    const res = await request(app).get('/api/invoices?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('limit must be between 1 and 100');
  });

  it('handles database errors gracefully', async () => {
    findManyMock.mockRejectedValue(new Error('DB connection failed'));
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(500); // Standard error handler should catch it
  });
});
