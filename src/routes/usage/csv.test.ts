import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { createUsageCsvRouter, escapeCsvField, writeChunk, type BackpressureSink } from './csv.js';
import {
  InMemoryUsageEventsRepository,
  type UsageEvent,
  type UsageEventsRepository,
} from '../../repositories/usageEventsRepository.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';

const USER_ID = 'user-1';

const makeEvent = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'evt-1',
  developerId: USER_ID,
  apiId: 'api-1',
  endpoint: '/v1/resource',
  userId: USER_ID,
  occurredAt: new Date('2026-03-01T10:00:00.000Z'),
  revenue: 1000n,
  ...overrides,
});

function createTestApp(repo: Pick<UsageEventsRepository, 'findByUser'>): express.Express {
  const app = express();
  app.use(requestIdMiddleware);
  app.use('/api/usage/csv', createUsageCsvRouter({ usageEventsRepository: repo }));
  app.use(errorHandler);
  return app;
}

const auth = (req: request.Test): request.Test => req.set('x-user-id', USER_ID);

// Wide range covering the fixed event timestamps used in the tests below.
const WIDE_RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.000Z' };

describe('escapeCsvField', () => {
  it('passes through plain values unchanged', () => {
    expect(escapeCsvField('api-123')).toBe('api-123');
  });

  it('quotes and escapes values containing commas, quotes, and newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(escapeCsvField('=1+1')).toBe("'=1+1");
    expect(escapeCsvField('+cmd')).toBe("'+cmd");
    expect(escapeCsvField('-2')).toBe("'-2");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('both neutralises and quotes when a value is dangerous and contains delimiters', () => {
    expect(escapeCsvField('=HYPERLINK("x"),y')).toBe('"\'=HYPERLINK(""x""),y"');
  });
});

describe('writeChunk (backpressure handling)', () => {
  class FakeSink extends EventEmitter implements BackpressureSink {
    public writes: string[] = [];
    constructor(private readonly writeReturn: boolean) {
      super();
    }
    write(chunk: string): boolean {
      this.writes.push(chunk);
      return this.writeReturn;
    }
  }

  it('resolves immediately when the buffer is not full', async () => {
    const sink = new FakeSink(true);
    await expect(writeChunk(sink, 'data')).resolves.toBeUndefined();
    expect(sink.writes).toEqual(['data']);
  });

  it('waits for drain when the buffer is full, then resolves', async () => {
    const sink = new FakeSink(false);
    const promise = writeChunk(sink, 'data');
    expect(sink.listenerCount('drain')).toBe(1);
    sink.emit('drain');
    await expect(promise).resolves.toBeUndefined();
    // Listeners are cleaned up after resolving.
    expect(sink.listenerCount('drain')).toBe(0);
    expect(sink.listenerCount('error')).toBe(0);
    expect(sink.listenerCount('close')).toBe(0);
  });

  it('rejects with the stream error when the stream errors before draining', async () => {
    const sink = new FakeSink(false);
    const promise = writeChunk(sink, 'data');
    const boom = new Error('socket exploded');
    sink.emit('error', boom);
    await expect(promise).rejects.toBe(boom);
    expect(sink.listenerCount('drain')).toBe(0);
  });

  it('rejects when the response closes before draining', async () => {
    const sink = new FakeSink(false);
    const promise = writeChunk(sink, 'data');
    sink.emit('close');
    await expect(promise).rejects.toThrow('Response closed before stream completed');
  });
});

describe('GET /api/usage/csv', () => {
  it('returns 401 when the request is unauthenticated', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await request(app).get('/api/usage/csv');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('streams a CSV with header and rows for the authenticated user', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'evt-1', apiId: 'api-1', revenue: 1500n }),
      makeEvent({ id: 'evt-2', apiId: 'api-2', revenue: 2500n }),
      makeEvent({ id: 'other', userId: 'someone-else' }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(request(app).get('/api/usage/csv').query(WIDE_RANGE));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-type']).toContain('charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="usage-export-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers['cache-control']).toBe('no-store');

    const lines = res.text.trimEnd().split('\n');
    expect(lines[0]).toBe('id,apiId,endpoint,occurredAt,revenue');
    expect(lines).toHaveLength(3); // header + 2 owned events
    expect(res.text).toContain('evt-1,api-1,/v1/resource,2026-03-01T10:00:00.000Z,1500');
    expect(res.text).toContain('evt-2,api-2,/v1/resource,2026-03-01T10:00:00.000Z,2500');
    expect(res.text).not.toContain('other'); // other users' rows excluded
  });

  it('returns only the header row when there are no matching events', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await auth(request(app).get('/api/usage/csv'));
    expect(res.status).toBe(200);
    expect(res.text).toBe('id,apiId,endpoint,occurredAt,revenue\n');
  });

  it('filters by apiId', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'evt-1', apiId: 'api-1' }),
      makeEvent({ id: 'evt-2', apiId: 'api-2' }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(request(app).get('/api/usage/csv').query({ apiId: 'api-2', ...WIDE_RANGE }));

    expect(res.status).toBe(200);
    expect(res.text).toContain('evt-2');
    expect(res.text).not.toContain('evt-1');
  });

  it('filters by from/to date range', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'in-range', occurredAt: new Date('2026-03-15T00:00:00.000Z') }),
      makeEvent({ id: 'out-of-range', occurredAt: new Date('2026-01-01T00:00:00.000Z') }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(
      request(app)
        .get('/api/usage/csv')
        .query({ from: '2026-03-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' }),
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain('in-range');
    expect(res.text).not.toContain('out-of-range');
  });

  it('escapes and neutralises malicious field content in the output', async () => {
    const repo = new InMemoryUsageEventsRepository([
      makeEvent({ id: 'evt-x', apiId: 'a,b', endpoint: '=HYPERLINK("http://evil")' }),
    ]);
    const app = createTestApp(repo);

    const res = await auth(request(app).get('/api/usage/csv').query(WIDE_RANGE));

    expect(res.status).toBe(200);
    expect(res.text).toContain('evt-x,"a,b","\'=HYPERLINK(""http://evil"")"');
  });

  it('returns 400 for an invalid "from" date', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await auth(request(app).get('/api/usage/csv').query({ from: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid "from" date');
  });

  it('returns 400 when "from" is supplied as multiple values', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await auth(request(app).get('/api/usage/csv?from=2026-01-01&from=2026-02-01'));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid "from" date');
  });

  it('returns 400 for an invalid "to" date', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await auth(request(app).get('/api/usage/csv').query({ to: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid "to" date');
  });

  it('returns 400 when apiId is supplied as multiple values', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await auth(request(app).get('/api/usage/csv?apiId=a&apiId=b'));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('apiId must be a single string value');
  });

  it('returns 400 when from is after to', async () => {
    const app = createTestApp(new InMemoryUsageEventsRepository());
    const res = await auth(
      request(app)
        .get('/api/usage/csv')
        .query({ from: '2026-03-31T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('from must be before or equal to to');
  });

  it('pages through the repository in batches for large exports', async () => {
    const events = Array.from({ length: 600 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, occurredAt: new Date(Date.now() - 1000) }),
    );
    const repo = new InMemoryUsageEventsRepository(events);
    const spy = jest.spyOn(repo, 'findByUser');
    const app = createTestApp(repo);

    const res = await auth(request(app).get('/api/usage/csv'));

    expect(res.status).toBe(200);
    // header + 600 rows
    expect(res.text.trimEnd().split('\n')).toHaveLength(601);
    // Two pages: offset 0 (500 rows) then offset 500 (100 rows).
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ limit: 500, offset: 0 });
    expect(spy.mock.calls[1][0]).toMatchObject({ limit: 500, offset: 500 });
  });

  it('returns a 500 JSON envelope when the first page query fails before streaming', async () => {
    const repo: Pick<UsageEventsRepository, 'findByUser'> = {
      findByUser: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const app = createTestApp(repo);

    const res = await auth(request(app).get('/api/usage/csv'));

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('aborts the connection when a query fails mid-stream', async () => {
    const firstPage = Array.from({ length: 500 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, occurredAt: new Date(Date.now() - 1000) }),
    );
    const findByUser = jest
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('db down mid-stream'));
    const app = createTestApp({ findByUser });

    // Headers/body have already been committed, so the server destroys the
    // socket; superagent surfaces that as a request error.
    await expect(auth(request(app).get('/api/usage/csv'))).rejects.toThrow();
    expect(findByUser).toHaveBeenCalledTimes(2);
  });
});
