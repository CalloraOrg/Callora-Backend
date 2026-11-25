import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import express from 'express';
import { GenericContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import request from 'supertest';
import { createIdempotencyMiddleware } from '../../src/middleware/idempotency.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { sweepIdempotencyStoreRows } from '../../src/services/idempotencySweeper.js';

const migrationsDirectory = path.resolve(process.cwd(), 'migrations');
const dockerAvailable = process.env.DATABASE_URL
  ? false
  : spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 }).status === 0;
const canRunSuite = Boolean(process.env.DATABASE_URL) || dockerAvailable;

if (!canRunSuite) {
  console.warn('Skipping idempotency lifecycle integration tests: DATABASE_URL is unset and Docker is unavailable.');
}

const lifecycleSuite = canRunSuite ? describe : describe.skip;

lifecycleSuite('Idempotency lifecycle against PostgreSQL', () => {
  let pool: Pool | undefined;
  let adminPool: Pool | undefined;
  let container: Awaited<ReturnType<GenericContainer['start']>> | undefined;
  let schema: string | undefined;

  beforeAll(async () => {
    let connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      container = await new GenericContainer('postgres:16-alpine')
        .withEnvironment({
          POSTGRES_DB: 'test_idempotency',
          POSTGRES_USER: 'test_user',
          POSTGRES_PASSWORD: 'test_password',
        })
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withExposedPorts(5432)
        .start();
      connectionString = `postgresql://test_user:test_password@${container.getHost()}:${container.getMappedPort(5432)}/test_idempotency`;
    }

    schema = `idempotency_test_${randomUUID().replaceAll('-', '')}`;
    adminPool = new Pool({ connectionString });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });

    for (const migration of [
      '004_create_idempotency_store.sql',
      '0025_idempotency_store_scope.sql',
      '0028_idempotency_lease.sql',
    ]) {
      const sql = await readFile(path.join(migrationsDirectory, migration), 'utf8');
      await pool.query(sql);
    }
  }, 60000);

  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      try {
        if (adminPool && schema) {
          await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        try {
          await adminPool?.end();
        } finally {
          await container?.stop();
        }
      }
    }
  }, 30000);

  beforeEach(async () => {
    await pool!.query('DELETE FROM idempotency_store');
  });

  async function waitForStatus(key: string, status: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await pool!.query(
        'SELECT status FROM idempotency_store WHERE scope = $1 AND idempotency_key = $2',
        ['anonymous', key],
      );
      if (result.rows[0]?.status === status) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Idempotency row ${key} did not reach status ${status}`);
  }

  async function waitForDeletion(key: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await pool!.query(
        'SELECT 1 FROM idempotency_store WHERE scope = $1 AND idempotency_key = $2',
        ['anonymous', key],
      );
      if (result.rowCount === 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Idempotency row ${key} was not released`);
  }

  function createApp(handler: express.RequestHandler): express.Express {
    const app = express();
    app.locals.dbPool = pool;
    app.use(express.json());
    app.use(createIdempotencyMiddleware());
    app.post('/resource', handler);
    app.use(errorHandler);
    return app;
  }

  it('stores the first response, replays a matching request, and rejects a different body', async () => {
    let calls = 0;
    const app = createApp((req, res) => {
      calls += 1;
      res.status(201).json({ call: calls, received: req.body });
    });

    const first = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'lifecycle-key')
      .send({ first: 1, second: { alpha: true, beta: 2 } })
      .expect(201);
    expect(first.body).toEqual({ call: 1, received: { first: 1, second: { alpha: true, beta: 2 } } });

    await waitForStatus('lifecycle-key', 'completed');
    const stored = await pool!.query(
      `SELECT status, response_status FROM idempotency_store WHERE scope = 'anonymous' AND idempotency_key = $1`,
      ['lifecycle-key'],
    );
    expect(stored.rows).toEqual([{ status: 'completed', response_status: 201 }]);

    const replay = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'lifecycle-key')
      .send({ second: { beta: 2, alpha: true }, first: 1 })
      .expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(calls).toBe(1);

    const mismatch = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'lifecycle-key')
      .send({ first: 2 })
      .expect(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE_MISMATCH');
    expect(calls).toBe(1);
  });

  it('releases the lease after a 5xx response so a retry runs the handler again', async () => {
    let calls = 0;
    const app = createApp((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.status(503).json({ error: 'temporary failure' });
        return;
      }
      res.status(200).json({ call: calls });
    });

    await request(app).post('/resource').set('Idempotency-Key', 'retry-key').send({ value: 1 }).expect(503);
    await waitForDeletion('retry-key');
    const afterFailure = await pool!.query(
      'SELECT status FROM idempotency_store WHERE scope = $1 AND idempotency_key = $2',
      ['anonymous', 'retry-key'],
    );
    expect(afterFailure.rowCount).toBe(0);

    const retry = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'retry-key')
      .send({ value: 1 })
      .expect(200);
    expect(retry.body).toEqual({ call: 2 });
    expect(calls).toBe(2);
  });

  it('reclaims expired keys and sweeps expired rows while retaining live rows', async () => {
    let calls = 0;
    const app = createApp((_req, res) => {
      calls += 1;
      res.json({ call: calls });
    });

    await request(app).post('/resource').set('Idempotency-Key', 'expired-key').send({ value: 1 }).expect(200);
    await pool!.query(
      `UPDATE idempotency_store SET expires_at = NOW()::timestamp - INTERVAL '1 second'
       WHERE scope = $1 AND idempotency_key = $2`,
      ['anonymous', 'expired-key'],
    );

    await request(app).post('/resource').set('Idempotency-Key', 'expired-key').send({ value: 1 }).expect(200);
    expect(calls).toBe(2);
    await waitForStatus('expired-key', 'completed');
    const reclaimed = await pool!.query(
      `SELECT status, expires_at > NOW()::timestamp AS live FROM idempotency_store
       WHERE scope = $1 AND idempotency_key = $2`,
      ['anonymous', 'expired-key'],
    );
    expect(reclaimed.rows).toEqual([{ status: 'completed', live: true }]);

    await pool!.query(
      `INSERT INTO idempotency_store
         (scope, idempotency_key, request_hash, status, expires_at, created_at, lease_expires_at)
       VALUES
         ('anonymous', 'sweep-expired', 'hash', 'started', NOW()::timestamp - INTERVAL '1 second', NOW(), NOW()),
         ('anonymous', 'sweep-live', 'hash', 'started', NOW()::timestamp + INTERVAL '1 hour', NOW(), NOW())`,
    );

    await sweepIdempotencyStoreRows(pool!);
    const remaining = await pool!.query(
      'SELECT idempotency_key FROM idempotency_store ORDER BY idempotency_key',
    );
    expect(remaining.rows.map(row => row.idempotency_key)).toEqual(['expired-key', 'sweep-live']);
  });

  it('rejects concurrent duplicate requests while the first request is started', async () => {
    let signalStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const handlerReleased = new Promise<void>(resolve => { releaseHandler = resolve; });
    let calls = 0;
    const app = createApp(async (_req, res) => {
      calls += 1;
      signalStarted();
      await handlerReleased;
      res.json({ call: calls });
    });

    const firstRequest = request(app)
      .post('/resource')
      .set('Idempotency-Key', 'concurrent-key')
      .send({ value: 1 })
      .expect(200)
      .then(response => response);
    await started;

    const startedRow = await pool!.query(
      'SELECT status FROM idempotency_store WHERE scope = $1 AND idempotency_key = $2',
      ['anonymous', 'concurrent-key'],
    );
    expect(startedRow.rows).toEqual([{ status: 'started' }]);

    const duplicate = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'concurrent-key')
      .send({ value: 1 })
      .expect(409);
    expect(duplicate.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(calls).toBe(1);

    releaseHandler();
    await firstRequest;
  });

  it('passes through missing keys and rejects invalid or overlong keys', async () => {
    let calls = 0;
    const app = createApp((_req, res) => {
      calls += 1;
      res.json({ call: calls });
    });

    await request(app).post('/resource').send({ value: 1 }).expect(200);

    const invalid = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'invalid/key')
      .send({ value: 2 })
      .expect(400);
    expect(invalid.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');

    const overlong = await request(app)
      .post('/resource')
      .set('Idempotency-Key', 'k'.repeat(256))
      .send({ value: 3 })
      .expect(400);
    expect(overlong.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(calls).toBe(1);
    const stored = await pool!.query('SELECT COUNT(*)::int AS count FROM idempotency_store');
    expect(stored.rows[0].count).toBe(0);
  });
});
