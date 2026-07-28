import request from 'supertest';
import express from 'express';
import usageRouter from '../usage';
import prisma from '../../lib/prisma';

jest.mock('../../lib/prisma', () => ({
  usageEvent: {
    findMany: jest.fn(),
  },
}));
jest.mock('../../logger', () => ({
  logger: { info: jest.fn(), error: jest.fn() }
}));

const app = express();
app.use(express.json());
app.use('/usage', usageRouter);

describe('GET /usage (Cursor Pagination)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockData = [
    { id: '3', created_at: new Date('2026-10-12T10:00:00Z') },
    { id: '2', created_at: new Date('2026-10-12T10:00:00Z') },
    { id: '1', created_at: new Date('2026-10-11T10:00:00Z') },
  ];

  it('should return 400 for invalid limits', async () => {
    const response = await request(app).get('/usage?limit=500');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('should return 400 for malformed cursor strings', async () => {
    const response = await request(app).get('/usage?cursor=invalid_base64_string');
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('Invalid pagination parameters');
  });

  it('should fetch first page and generate next_cursor correctly', async () => {
    (prisma.usageEvent.findMany as jest.Mock).mockResolvedValue(mockData);

    const response = await request(app).get('/usage?limit=2');
    
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0].id).toBe('3');
    expect(response.body.meta.has_more).toBe(true);
    
    const expectedCursorPayload = JSON.stringify({ 
      c: mockData[1].created_at.toISOString(), 
      i: mockData[1].id 
    });
    const expectedCursor = Buffer.from(expectedCursorPayload).toString('base64');
    expect(response.body.meta.next_cursor).toBe(expectedCursor);
  });

  it('should construct correct WHERE clause when passing a cursor', async () => {
    const cursorPayload = JSON.stringify({ 
      c: '2026-10-12T10:00:00.000Z', 
      i: '2' 
    });
    const cursor = Buffer.from(cursorPayload).toString('base64');
    
    (prisma.usageEvent.findMany as jest.Mock).mockResolvedValue([mockData[2]]);

    await request(app).get(`/usage?cursor=${cursor}&limit=1`);

    expect(prisma.usageEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { created_at: { lt: new Date('2026-10-12T10:00:00.000Z') } },
            { created_at: new Date('2026-10-12T10:00:00.000Z'), id: { lt: '2' } }
          ]
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: 2,
      })
    );
  });
});