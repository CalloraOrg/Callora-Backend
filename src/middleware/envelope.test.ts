import request from 'supertest';
import express from 'express';
import {
  envelopeMiddleware,
  createResponseValidatorMiddleware,
  buildSuccessEnvelope,
  buildErrorEnvelope,
  successEnvelopeSchema,
  errorEnvelopeSchema,
  envelopeSchema,
} from './envelope.js';

function createTestApp(useValidator = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { id?: string }).id = 'test-request-id';
    next();
  });
  app.use(createResponseValidatorMiddleware());
  app.use(envelopeMiddleware);
  return app;
}

describe('buildSuccessEnvelope', () => {
  it('creates a valid success envelope with data', () => {
    const env = buildSuccessEnvelope({ foo: 'bar' }, 'req-123');
    expect(env.success).toBe(true);
    expect(env.data).toEqual({ foo: 'bar' });
    expect(env.requestId).toBe('req-123');
    expect(env.timestamp).toBeTruthy();
    expect(() => new Date(env.timestamp)).not.toThrow();
    expect(successEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('includes meta when provided', () => {
    const env = buildSuccessEnvelope([1, 2, 3], 'req-456', { total: 3, limit: 10 });
    expect(env.meta).toEqual({ total: 3, limit: 10 });
    expect(successEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('omits meta when empty', () => {
    const env = buildSuccessEnvelope('data', 'req-789', {});
    expect('meta' in env).toBe(false);
  });
});

describe('buildErrorEnvelope', () => {
  it('creates a valid error envelope with code and message', () => {
    const env = buildErrorEnvelope('NOT_FOUND', 'Item missing', 'req-1');
    expect(env.success).toBe(false);
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.message).toBe('Item missing');
    expect(env.requestId).toBe('req-1');
    expect(env.timestamp).toBeTruthy();
    expect(errorEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('includes details when provided', () => {
    const details = [{ field: 'body.name', message: 'required', code: 'INVALID_VALUE' }];
    const env = buildErrorEnvelope('VALIDATION_ERROR', 'bad input', 'req-2', details);
    expect(env.error.details).toEqual(details);
    expect(errorEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('omits details when empty', () => {
    const env = buildErrorEnvelope('BAD_REQUEST', 'x', 'req-3', []);
    expect('details' in env.error).toBe(false);
  });
});

describe('envelopeSchema union', () => {
  it('accepts success envelope', () => {
    const env = buildSuccessEnvelope({ a: 1 }, 'r');
    expect(envelopeSchema.safeParse(env).success).toBe(true);
  });

  it('accepts error envelope', () => {
    const env = buildErrorEnvelope('ERR', 'm', 'r');
    expect(envelopeSchema.safeParse(env).success).toBe(true);
  });

  it('rejects malformed', () => {
    expect(envelopeSchema.safeParse({ success: true }).success).toBe(false);
    expect(envelopeSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('envelopeMiddleware + validator middleware stack (contract order)', () => {
  it('wraps plain object success responses through validator + wrapper', async () => {
    const app = createTestApp();
    app.get('/obj', (_req, res) => {
      res.json({ id: 1, name: 'test' });
    });
    const res = await request(app).get('/obj');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ id: 1, name: 'test' });
    expect(res.body.requestId).toBe('test-request-id');
    expect(res.body.timestamp).toBeTruthy();
    expect(envelopeSchema.safeParse(res.body).success).toBe(true);
  });

  it('wraps array success responses', async () => {
    const app = createTestApp();
    app.get('/arr', (_req, res) => {
      res.json([1, 2, 3]);
    });
    const res = await request(app).get('/arr');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([1, 2, 3]);
  });

  it('wraps primitive success responses', async () => {
    const app = createTestApp();
    app.get('/str', (_req, res) => {
      res.json('ok');
    });
    app.get('/num', (_req, res) => {
      res.json(42);
    });
    app.get('/bool', (_req, res) => {
      res.json(true);
    });
    const strRes = await request(app).get('/str');
    expect(strRes.body.data).toBe('ok');
    const numRes = await request(app).get('/num');
    expect(numRes.body.data).toBe(42);
    const boolRes = await request(app).get('/bool');
    expect(boolRes.body.data).toBe(true);
  });

  it('unpacks { data, meta } pattern into envelope.meta', async () => {
    const app = createTestApp();
    app.get('/paginated', (_req, res) => {
      res.json({
        data: [{ id: 1 }],
        meta: { limit: 20, offset: 0, total: 1 },
      });
    });
    const res = await request(app).get('/paginated');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([{ id: 1 }]);
    expect(res.body.meta).toEqual({ limit: 20, offset: 0, total: 1 });
  });

  it('does not double-wrap already-enveloped responses', async () => {
    const app = createTestApp();
    app.get('/wrapped', (_req, res) => {
      const env = buildSuccessEnvelope('already-wrapped', 'test-request-id');
      res.json(env);
    });
    const res = await request(app).get('/wrapped');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBe('already-wrapped');
    expect('data' in (res.body as { data?: unknown }).data).toBe(false);
  });

  it('wraps error-status responses with code+message into error envelope', async () => {
    const app = createTestApp();
    app.get('/err-sim', (_req, res) => {
      res.status(502).json({
        error: 'Soroban simulation failed',
        code: 'SIMULATION_FAILED',
      });
    });
    const res = await request(app).get('/err-sim');
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SIMULATION_FAILED');
    expect(res.body.error.message).toBe('Soroban simulation failed');
    expect(res.body.requestId).toBe('test-request-id');
    expect(envelopeSchema.safeParse(res.body).success).toBe(true);
  });

  it('wraps generic 400 responses into error envelope with defaults', async () => {
    const app = createTestApp();
    app.get('/bad', (_req, res) => {
      res.status(400).json({});
    });
    const res = await request(app).get('/bad');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('wraps 500 status responses with INTERNAL_SERVER_ERROR code', async () => {
    const app = createTestApp();
    app.get('/boom', (_req, res) => {
      res.status(500).json({ message: 'something broke' });
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.message).toBe('something broke');
  });

  it('passes through CSV content-type untouched', async () => {
    const app = createTestApp();
    app.get('/csv', (_req, res) => {
      res.setHeader('Content-Type', 'text/csv');
      res.json('a,b,c');
    });
    const res = await request(app).get('/csv');
    expect(res.body).toBe('a,b,c');
  });

  it('passes through PDF content-type untouched', async () => {
    const app = createTestApp();
    app.get('/pdf', (_req, res) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from('%PDF-binary-blob'));
    });
    const res = await request(app).get('/pdf');
    expect(envelopeSchema.safeParse(res.body).success).toBe(false);
    expect(res.status).toBe(200);
  });

  it('passes through text/event-stream content-type untouched', async () => {
    const app = createTestApp();
    app.get('/sse', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.status(200);
      res.write('event: connected\ndata: {}\n\n');
      res.end();
    });
    const res = await request(app).get('/sse');
    expect(res.status).toBe(200);
    expect(envelopeSchema.safeParse(res.body).success).toBe(false);
  });

  it('passes through text/plain prometheus-style metrics untouched', async () => {
    const app = createTestApp();
    app.get('/metrics', (_req, res) => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send('http_requests_total 100\n');
    });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/http_requests_total/);
    expect(envelopeSchema.safeParse(res.body).success).toBe(false);
  });

  it('wraps res.send(string) JSON payloads', async () => {
    const app = createTestApp();
    app.get('/send-json-str', (_req, res) => {
      res.send('{"hello":"world"}');
    });
    const res = await request(app).get('/send-json-str');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ hello: 'world' });
    expect(envelopeSchema.safeParse(res.body).success).toBe(true);
  });

  it('does not wrap res.send(string) non-JSON text', async () => {
    const app = createTestApp();
    app.get('/send-text', (_req, res) => {
      res.send('hello world, this is not json');
    });
    const res = await request(app).get('/send-text');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/hello world/);
    expect(typeof (res.body as { success?: unknown }).success).not.toBe('boolean');
  });

  it('does not wrap res.send(Buffer) binary', async () => {
    const app = createTestApp();
    app.get('/buffer', (_req, res) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    });
    const res = await request(app).get('/buffer');
    expect(res.status).toBe(200);
    expect(envelopeSchema.safeParse(res.body).success).toBe(false);
  });
});

describe('createResponseValidatorMiddleware contract enforcement', () => {
  it('allows properly-formed success envelopes through', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { id?: string }).id = 'req-ok';
      next();
    });
    app.use(createResponseValidatorMiddleware());
    app.get('/good', (_req, res) => {
      res.json(buildSuccessEnvelope({ hello: 'world' }, 'req-ok'));
    });
    const res = await request(app).get('/good');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ hello: 'world' });
  });

  it('allows properly-formed error envelopes through', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { id?: string }).id = 'req-err';
      next();
    });
    app.use(createResponseValidatorMiddleware());
    app.get('/err', (_req, res) => {
      res.status(404).json(buildErrorEnvelope('NOT_FOUND', 'gone', 'req-err'));
    });
    const res = await request(app).get('/err');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed success responses with 500 contract violation', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { id?: string }).id = 'req-v';
      next();
    });
    app.use(createResponseValidatorMiddleware());
    app.get('/bad-resp', (_req, res) => {
      res.json({ unexpected: 'shape' });
    });

    const res = await request(app).get('/bad-resp');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.message).toMatch(/contract violation/i);
  });

  it('validates optional per-endpoint data schema on success.data', async () => {
    const { z } = await import('zod');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { id?: string }).id = 'req-schema';
      next();
    });
    app.use('/typed', createResponseValidatorMiddleware(z.object({
      id: z.number(),
      name: z.string(),
    })));
    app.get('/typed/good', (_req, res) => {
      res.json(buildSuccessEnvelope({ id: 42, name: 'Alice' }, 'req-schema'));
    });
    app.get('/typed/bad', (_req, res) => {
      res.json(buildSuccessEnvelope({ id: 'not-a-number', name: 123 }, 'req-schema'));
    });

    const goodRes = await request(app).get('/typed/good');
    expect(goodRes.status).toBe(200);
    expect(goodRes.body.data.id).toBe(42);

    const badRes = await request(app).get('/typed/bad');
    expect(badRes.status).toBe(500);
    expect(badRes.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(badRes.body.error.message).toMatch(/contract violation/i);
  });
});

describe('canonical envelope contract: shared fields', () => {
  it('always contains boolean success, requestId, ISO timestamp', async () => {
    const app = createTestApp();
    const endpoints: Array<[string, number]> = [
      ['/success', 200],
      ['/created', 201],
      ['/bad', 400],
      ['/notfound', 404],
      ['/error', 500],
    ];
    app.get('/success', (_req, res) => res.json({ ok: true }));
    app.get('/created', (_req, res) => res.status(201).json({ id: 1 }));
    app.get('/bad', (_req, res) => res.status(400).json({ message: 'bad' }));
    app.get('/notfound', (_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'missing' }));
    app.get('/error', (_req, res) => res.status(500).json({ code: 'CRASH', message: 'oops' }));

    for (const [path, expectedStatus] of endpoints) {
      const res = await request(app).get(path);
      expect(res.status).toBe(expectedStatus);
      const parsed = envelopeSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(typeof parsed.data.success).toBe('boolean');
      expect(typeof parsed.data.requestId).toBe('string');
      expect(parsed.data.requestId.length).toBeGreaterThan(0);
      expect(() => new Date(parsed.data.timestamp)).not.toThrow();
      expect(parsed.data.timestamp.endsWith('Z')).toBe(true);
    }
  });

  it('error envelope has nested error.code and error.message strings', async () => {
    const app = createTestApp();
    app.get('/validation', (_req, res) => {
      res.status(422).json({
        code: 'VALIDATION_FAILED',
        message: 'invalid fields',
        details: [{ field: 'body.email', message: 'required', code: 'MISSING' }],
      });
    });
    const res = await request(app).get('/validation');
    expect(res.status).toBe(422);
    const parsed = errorEnvelopeSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(typeof parsed.data.error.code).toBe('string');
    expect(typeof parsed.data.error.message).toBe('string');
    expect(parsed.data.error.details).toBeDefined();
    expect(Array.isArray(parsed.data.error.details)).toBe(true);
  });

  it('success envelope has data field; meta present only when set', async () => {
    const app = createTestApp();
    app.get('/plain', (_req, res) => res.json({ result: 1 }));
    app.get('/paginated', (_req, res) => res.json({
      data: [{ id: 1 }],
      meta: { limit: 10, offset: 0, total: 5 },
    }));

    const plainRes = await request(app).get('/plain');
    expect(plainRes.status).toBe(200);
    expect('data' in plainRes.body).toBe(true);
    expect('meta' in plainRes.body).toBe(false);

    const paginatedRes = await request(app).get('/paginated');
    expect(paginatedRes.status).toBe(200);
    expect('data' in paginatedRes.body).toBe(true);
    expect('meta' in paginatedRes.body).toBe(true);
    expect(paginatedRes.body.meta).toEqual({ limit: 10, offset: 0, total: 5 });
  });
});
