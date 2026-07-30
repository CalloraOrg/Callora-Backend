/**
 * @file src/routes/auth.test.ts
 * @description Tests for the auth_index.sql migration files and the
 * src/routes/auth.ts router factory (issue #902).
 *
 * Coverage matrix
 * ───────────────
 * Migration SQL content (auth_index.sql)
 *   ✓  Both composite index names are present
 *   ✓  Both CREATE INDEX statements target the refresh_tokens table
 *   ✓  Both indexes include a WHERE is_revoked = FALSE partial predicate
 *   ✓  idx_refresh_tokens_id_user_active covers columns (id, user_id)
 *   ✓  idx_refresh_tokens_hash_user_active covers columns (token_hash, user_id)
 *   ✓  idx_refresh_tokens_hash_user_active is declared UNIQUE
 *   ✓  Both CREATE INDEX statements use IF NOT EXISTS (idempotent)
 *   ✓  Both indexes include a COMMENT ON INDEX documenting the issue
 *
 * Migration SQL content (auth_index.down.sql)
 *   ✓  Both DROP INDEX statements are present
 *   ✓  Both DROP INDEX statements use IF NOT EXISTS (safe to run multiple times)
 *   ✓  Rollback drops indexes in reverse order (hash first, then id)
 *   ✓  No CREATE statements appear in the down file
 *
 * Migration file pairing (regression guard for the existing down-coverage suite)
 *   ✓  auth_index.sql exists on disk
 *   ✓  auth_index.down.sql exists on disk
 *   ✓  Both files are non-empty
 *
 * Route surface — src/routes/auth.ts
 *   ✓  POST /api/auth/refresh returns 400 when refreshToken is absent
 *   ✓  POST /api/auth/refresh returns 400 when refreshToken is empty string
 *   ✓  POST /api/auth/refresh returns 400 with standard error envelope
 *   ✓  POST /api/auth/refresh calls authController.refreshToken on valid body
 *   ✓  POST /api/auth/revoke  returns 400 when refreshToken is absent
 *   ✓  POST /api/auth/revoke  calls authController.revokeToken on valid body
 *   ✓  POST /api/auth/revoke-all returns 401 without authentication
 *   ✓  POST /api/auth/revoke-all calls authController.revokeAllTokens when authenticated
 *   ✓  GET  /api/auth/tokens  returns 401 without authentication
 *   ✓  GET  /api/auth/tokens  calls authController.getTokenInfo when authenticated
 *   ✓  Every response carries an X-Request-Id header
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import express from 'express';

import { createAuthRouter } from './auth.js';
import { AuthController } from '../controllers/authController.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const migrationsDir = path.join(process.cwd(), 'migrations');
const upFile   = path.join(migrationsDir, 'auth_index.sql');
const downFile = path.join(migrationsDir, 'auth_index.down.sql');

// ---------------------------------------------------------------------------
// Migration SQL content tests
// ---------------------------------------------------------------------------

describe('auth_index.sql — forward migration', () => {
  let sql: string;

  beforeAll(() => {
    sql = fs.readFileSync(upFile, 'utf8');
  });

  // File exists (regression guard for the down-coverage suite in
  // migrate.runner.test.ts — that suite scans the real migrations dir)
  it('file exists on disk', () => {
    expect(fs.existsSync(upFile)).toBe(true);
  });

  it('is non-empty', () => {
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  // Index 1 — (id, user_id) partial
  it('creates idx_refresh_tokens_id_user_active', () => {
    expect(sql).toMatch(/idx_refresh_tokens_id_user_active/);
  });

  it('idx_refresh_tokens_id_user_active targets the refresh_tokens table', () => {
    // The CREATE INDEX for index 1 must reference refresh_tokens
    const block = sql.match(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_id_user_active[\s\S]*?WHERE[^\n]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ON\s+refresh_tokens/i);
  });

  it('idx_refresh_tokens_id_user_active includes column id', () => {
    const block = sql.match(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_id_user_active\s+ON[^;]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\bid\b/);
  });

  it('idx_refresh_tokens_id_user_active includes column user_id', () => {
    const block = sql.match(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_id_user_active\s+ON[^;]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/user_id/);
  });

  it('idx_refresh_tokens_id_user_active has a partial predicate WHERE is_revoked = FALSE', () => {
    const block = sql.match(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_id_user_active[\s\S]*?WHERE[^\n;]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/WHERE\s+is_revoked\s*=\s*FALSE/i);
  });

  it('idx_refresh_tokens_id_user_active uses IF NOT EXISTS (idempotent)', () => {
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_id_user_active/i,
    );
  });

  // Index 2 — (token_hash, user_id) partial UNIQUE
  it('creates idx_refresh_tokens_hash_user_active', () => {
    expect(sql).toMatch(/idx_refresh_tokens_hash_user_active/);
  });

  it('idx_refresh_tokens_hash_user_active is declared UNIQUE', () => {
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_hash_user_active/i,
    );
  });

  it('idx_refresh_tokens_hash_user_active targets the refresh_tokens table', () => {
    const block = sql.match(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_hash_user_active[\s\S]*?WHERE[^\n]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ON\s+refresh_tokens/i);
  });

  it('idx_refresh_tokens_hash_user_active includes column token_hash', () => {
    const block = sql.match(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_hash_user_active\s+ON[^;]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/token_hash/);
  });

  it('idx_refresh_tokens_hash_user_active includes column user_id', () => {
    const block = sql.match(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_hash_user_active\s+ON[^;]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/user_id/);
  });

  it('idx_refresh_tokens_hash_user_active has a partial predicate WHERE is_revoked = FALSE', () => {
    const block = sql.match(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_hash_user_active[\s\S]*?WHERE[^\n;]+/i,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/WHERE\s+is_revoked\s*=\s*FALSE/i);
  });

  it('idx_refresh_tokens_hash_user_active uses IF NOT EXISTS (idempotent)', () => {
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refresh_tokens_hash_user_active/i,
    );
  });

  // Documentation comments
  it('includes a COMMENT ON INDEX for idx_refresh_tokens_id_user_active', () => {
    expect(sql).toMatch(/COMMENT\s+ON\s+INDEX\s+idx_refresh_tokens_id_user_active/i);
  });

  it('includes a COMMENT ON INDEX for idx_refresh_tokens_hash_user_active', () => {
    expect(sql).toMatch(/COMMENT\s+ON\s+INDEX\s+idx_refresh_tokens_hash_user_active/i);
  });

  // Issue traceability
  it('references issue #902 in the file', () => {
    expect(sql).toMatch(/#902/);
  });
});

describe('auth_index.down.sql — rollback migration', () => {
  let sql: string;

  beforeAll(() => {
    sql = fs.readFileSync(downFile, 'utf8');
  });

  it('file exists on disk', () => {
    expect(fs.existsSync(downFile)).toBe(true);
  });

  it('is non-empty', () => {
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  it('drops idx_refresh_tokens_id_user_active', () => {
    expect(sql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+idx_refresh_tokens_id_user_active/i);
  });

  it('drops idx_refresh_tokens_hash_user_active', () => {
    expect(sql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+idx_refresh_tokens_hash_user_active/i);
  });

  it('uses IF EXISTS on both DROP statements (safe to run multiple times)', () => {
    const drops = sql.match(/DROP\s+INDEX\s+IF\s+EXISTS/gi) ?? [];
    expect(drops.length).toBe(2);
  });

  it('drops hash index before id index (reverse order of creation)', () => {
    const hashPos = sql.indexOf('idx_refresh_tokens_hash_user_active');
    const idPos   = sql.indexOf('idx_refresh_tokens_id_user_active');
    expect(hashPos).toBeGreaterThan(-1);
    expect(idPos).toBeGreaterThan(-1);
    expect(hashPos).toBeLessThan(idPos);
  });

  it('contains no CREATE statements', () => {
    // A down migration must not create anything
    expect(sql).not.toMatch(/\bCREATE\b/i);
  });

  it('references issue #902 in the file', () => {
    expect(sql).toMatch(/#902/);
  });
});

describe('auth_index migration — file pairing', () => {
  it('auth_index.sql and auth_index.down.sql both exist', () => {
    expect(fs.existsSync(upFile)).toBe(true);
    expect(fs.existsSync(downFile)).toBe(true);
  });

  it('the index names are consistent between up and down files', () => {
    const up   = fs.readFileSync(upFile,   'utf8');
    const down = fs.readFileSync(downFile, 'utf8');

    const indexNamesUp = [
      'idx_refresh_tokens_id_user_active',
      'idx_refresh_tokens_hash_user_active',
    ];

    for (const name of indexNamesUp) {
      expect(up).toMatch(name);
      expect(down).toMatch(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Route surface tests — src/routes/auth.ts
// ---------------------------------------------------------------------------

/** Stub AuthController — every method is a jest.fn() that sends a canned 200. */
function makeController(): jest.Mocked<AuthController> {
  return {
    refreshToken:   jest.fn((_req, res) => res.json({ accessToken: 'tok', tokenType: 'Bearer' })),
    revokeToken:    jest.fn((_req, res) => res.json({ message: 'ok' })),
    revokeAllTokens:jest.fn((_req, res) => res.json({ message: 'ok' })),
    getTokenInfo:   jest.fn((_req, res) => res.json({ activeRefreshTokens: 1, maxAllowedTokens: 5 })),
  } as any;
}

function buildApp(controller: jest.Mocked<AuthController>) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ authController: controller }));
  app.use(errorHandler);
  return app;
}

describe('POST /api/auth/refresh — input validation', () => {
  let ctrl: jest.Mocked<AuthController>;
  let app: express.Express;

  beforeEach(() => {
    ctrl = makeController();
    app  = buildApp(ctrl);
  });

  it('returns 400 when refreshToken is missing', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(400);
    // Standard error envelope
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('requestId');
    // Zod validation details array
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('returns 400 when refreshToken is an empty string', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: '' });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('does not invoke the controller when validation fails', async () => {
    await request(app).post('/api/auth/refresh').send({});
    expect(ctrl.refreshToken).not.toHaveBeenCalled();
  });

  it('invokes authController.refreshToken on a valid body', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'some-token' });
    expect(ctrl.refreshToken).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/revoke — input validation', () => {
  let ctrl: jest.Mocked<AuthController>;
  let app: express.Express;

  beforeEach(() => {
    ctrl = makeController();
    app  = buildApp(ctrl);
  });

  it('returns 400 when refreshToken is missing', async () => {
    const res = await request(app).post('/api/auth/revoke').send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('requestId');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('does not invoke the controller when validation fails', async () => {
    await request(app).post('/api/auth/revoke').send({});
    expect(ctrl.revokeToken).not.toHaveBeenCalled();
  });

  it('invokes authController.revokeToken on a valid body', async () => {
    const res = await request(app)
      .post('/api/auth/revoke')
      .send({ refreshToken: 'some-token' });
    expect(ctrl.revokeToken).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/revoke-all — authentication guard', () => {
  let ctrl: jest.Mocked<AuthController>;
  let app: express.Express;

  beforeEach(() => {
    ctrl = makeController();
    app  = buildApp(ctrl);
  });

  it('returns 401 when no credentials are supplied', async () => {
    const res = await request(app).post('/api/auth/revoke-all').send({});
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('requestId');
  });

  it('does not invoke the controller without authentication', async () => {
    await request(app).post('/api/auth/revoke-all').send({});
    expect(ctrl.revokeAllTokens).not.toHaveBeenCalled();
  });

  it('invokes authController.revokeAllTokens when x-user-id is provided', async () => {
    const res = await request(app)
      .post('/api/auth/revoke-all')
      .set('x-user-id', 'user-123')
      .send({});
    expect(ctrl.revokeAllTokens).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/auth/tokens — authentication guard', () => {
  let ctrl: jest.Mocked<AuthController>;
  let app: express.Express;

  beforeEach(() => {
    ctrl = makeController();
    app  = buildApp(ctrl);
  });

  it('returns 401 when no credentials are supplied', async () => {
    const res = await request(app).get('/api/auth/tokens');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('requestId');
  });

  it('does not invoke the controller without authentication', async () => {
    await request(app).get('/api/auth/tokens');
    expect(ctrl.getTokenInfo).not.toHaveBeenCalled();
  });

  it('invokes authController.getTokenInfo when x-user-id is provided', async () => {
    const res = await request(app)
      .get('/api/auth/tokens')
      .set('x-user-id', 'user-123');
    expect(ctrl.getTokenInfo).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe('X-Request-Id propagation', () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp(makeController());
  });

  it('every 200 response carries an X-Request-Id header', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'any' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('every 400 response carries an X-Request-Id header', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.headers['x-request-id']).toBeDefined();
    // requestId in the error body must match the header value
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a caller-supplied X-Request-Id', async () => {
    const correlationId = 'test-trace-abc-123';
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('x-request-id', correlationId)
      .send({ refreshToken: 'any' });
    expect(res.headers['x-request-id']).toBe(correlationId);
  });

  it('every 401 response carries an X-Request-Id header', async () => {
    const res = await request(app).post('/api/auth/revoke-all').send({});
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});
