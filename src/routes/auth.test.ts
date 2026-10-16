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
    const errObj = res.body.error ?? res.body;
    expect(errObj).toHaveProperty('code');
    expect(errObj).toHaveProperty('message');
    expect(res.body).toHaveProperty('requestId');
    expect(Array.isArray(errObj.details)).toBe(true);
    expect(errObj.details.length).toBeGreaterThan(0);
  });

  it('returns 400 when refreshToken is an empty string', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: '' });
    expect(res.status).toBe(400);
    const errObj = res.body.error ?? res.body;
    expect(Array.isArray(errObj.details)).toBe(true);
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
    const errObj = res.body.error ?? res.body;
    expect(errObj).toHaveProperty('code');
    expect(res.body).toHaveProperty('requestId');
    expect(Array.isArray(errObj.details)).toBe(true);
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
    process.env.JWT_SECRET = 'test-auth-route-jwt-secret';
    ctrl = makeController();
    app  = buildApp(ctrl);
  });

  it('returns 401 when no credentials are supplied', async () => {
    const res = await request(app).post('/api/auth/revoke-all').send({});
    expect(res.status).toBe(401);
    const errObj = res.body.error ?? res.body;
    expect(errObj).toHaveProperty('code');
    expect(res.body).toHaveProperty('requestId');
  });

  it('does not invoke the controller without authentication', async () => {
    await request(app).post('/api/auth/revoke-all').send({});
    expect(ctrl.revokeAllTokens).not.toHaveBeenCalled();
  });

  it('invokes authController.revokeAllTokens when valid Bearer token is provided', async () => {
    const token = jwt.sign({ userId: 'user-123' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    const res = await request(app)
      .post('/api/auth/revoke-all')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(ctrl.revokeAllTokens).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/auth/tokens — authentication guard', () => {
  let ctrl: jest.Mocked<AuthController>;
  let app: express.Express;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-auth-route-jwt-secret';
    ctrl = makeController();
    app  = buildApp(ctrl);
  });

  it('returns 401 when no credentials are supplied', async () => {
    const res = await request(app).get('/api/auth/tokens');
    expect(res.status).toBe(401);
    const errObj = res.body.error ?? res.body;
    expect(errObj).toHaveProperty('code');
    expect(res.body).toHaveProperty('requestId');
  });

  it('does not invoke the controller without authentication', async () => {
    await request(app).get('/api/auth/tokens');
    expect(ctrl.getTokenInfo).not.toHaveBeenCalled();
  });

  it('invokes authController.getTokenInfo when valid Bearer token is provided', async () => {
    const token = jwt.sign({ userId: 'user-123' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    const res = await request(app)
      .get('/api/auth/tokens')
      .set('Authorization', `Bearer ${token}`);
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

// ---------------------------------------------------------------------------
// POST /auth/wallet — Stellar signature verification (#1206)
// ---------------------------------------------------------------------------

import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import { createAuthRoutes } from './authRoutes.js';
import { createWalletLoginChallenge } from '../controllers/authController.js';
import { RefreshTokenService } from '../services/refreshTokenService.js';
import type { RefreshToken } from '../types/auth.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';

function createInMemoryRefreshTokenRepository(): RefreshTokenRepository & { stored: RefreshToken[] } {
  const stored: RefreshToken[] = [];
  return {
    stored,
    async createRefreshToken(token) {
      const record: RefreshToken = {
        ...token,
        id: token.id ?? 'test-id',
      };
      stored.push(record);
      return record;
    },
    async findRefreshTokenById(tokenId, userId) {
      return stored.find((t) => t.id === tokenId && t.userId === userId) ?? null;
    },
    async findRefreshTokenByHash(tokenHash, userId) {
      return stored.find((t) => t.tokenHash === tokenHash && t.userId === userId) ?? null;
    },
    async updateLastUsed() {},
    async revokeRefreshToken(tokenId, userId) {
      const target = stored.find((t) => t.id === tokenId && t.userId === userId);
      if (target) target.isRevoked = true;
    },
    async revokeFamily(familyId, userId) {
      for (const t of stored) {
        if (t.familyId === familyId && t.userId === userId) t.isRevoked = true;
      }
    },
    async revokeAllUserTokens(userId) {
      for (const t of stored) {
        if (t.userId === userId) t.isRevoked = true;
      }
    },
    async cleanupExpiredTokens() {
      return 0;
    },
    async countActiveTokens(userId) {
      return stored.filter((t) => t.userId === userId && !t.isRevoked).length;
    },
    async listRefreshTokens(userId, limit) {
      const list = stored.filter((t) => t.userId === userId).slice(0, limit);
      return { tokens: list, hasMore: false };
    },
  };
}

describe('POST /auth/wallet — Stellar wallet signature verification (#1206)', () => {
  const jwtSecret = 'test-wallet-jwt-secret-key-for-1206';
  let refreshTokenService: RefreshTokenService;
  let repository: ReturnType<typeof createInMemoryRefreshTokenRepository>;
  let authController: AuthController;
  let walletApp: express.Express;

  beforeEach(() => {
    refreshTokenService = new RefreshTokenService({
      jwtSecret,
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d',
    });
    repository = createInMemoryRefreshTokenRepository();
    authController = new AuthController({
      refreshTokenService,
      refreshTokenRepository: repository,
    });

    walletApp = express();
    walletApp.use(requestIdMiddleware);
    walletApp.use(express.json());
    walletApp.use('/auth', createAuthRoutes(authController));
    walletApp.use(errorHandler);
  });

  it('returns 200 with a valid access token and persisted refresh token for a valid Stellar signature', async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const message = createWalletLoginChallenge(walletAddress);
    const signature = keypair.sign(Buffer.from(message, 'utf8')).toString('hex');

    const res = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature, message });

    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(typeof data.accessToken).toBe('string');
    expect(typeof data.refreshToken).toBe('string');
    expect(data.tokenType).toBe('Bearer');

    const decoded = jwt.verify(data.accessToken, jwtSecret) as Record<string, unknown>;
    expect(decoded.userId).toBe(walletAddress);
    expect(decoded.walletAddress).toBe(walletAddress);
    expect(decoded.type).toBe('access');

    expect(repository.stored).toHaveLength(1);
    expect(repository.stored[0].userId).toBe(walletAddress);
  });

  it('accepts base64-encoded Stellar signatures as well as hex', async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const message = createWalletLoginChallenge(walletAddress);
    const signature = keypair.sign(Buffer.from(message, 'utf8')).toString('base64');

    const res = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature, message });

    expect(res.status).toBe(200);
    expect(repository.stored).toHaveLength(1);
  });

  it('returns 401 when signature was produced by a different keypair', async () => {
    const victimKeypair = Keypair.random();
    const attackerKeypair = Keypair.random();
    const walletAddress = victimKeypair.publicKey();
    const message = createWalletLoginChallenge(walletAddress);
    const signature = attackerKeypair.sign(Buffer.from(message, 'utf8')).toString('hex');

    const res = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature, message });

    expect(res.status).toBe(401);
    expect((res.body.error ?? res.body).code).toBe('INVALID_TOKEN');
    expect(repository.stored).toHaveLength(0);
  });

  it('returns 401 when the signed message is tampered with', async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const message = createWalletLoginChallenge(walletAddress);
    const signature = keypair.sign(Buffer.from(message, 'utf8')).toString('hex');

    const res = await request(walletApp)
      .post('/auth/wallet')
      .send({
        walletAddress,
        signature,
        message: `${message}\nTampered: true`,
      });

    expect(res.status).toBe(401);
    expect((res.body.error ?? res.body).code).toBe('INVALID_TOKEN');
    expect(repository.stored).toHaveLength(0);
  });

  it('returns 401 for malformed Stellar wallet addresses', async () => {
    const keypair = Keypair.random();
    const message = 'Callora Wallet Login';
    const signature = keypair.sign(Buffer.from(message, 'utf8')).toString('hex');

    const res = await request(walletApp)
      .post('/auth/wallet')
      .send({
        walletAddress: 'not-a-valid-stellar-public-key',
        signature,
        message,
      });

    expect(res.status).toBe(401);
    expect((res.body.error ?? res.body).code).toBe('INVALID_TOKEN');
  });

  it('returns 401 when the login challenge timestamp is expired', async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const expiredTimestamp = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const message = createWalletLoginChallenge(walletAddress, { timestamp: expiredTimestamp });
    const signature = keypair.sign(Buffer.from(message, 'utf8')).toString('hex');

    const res = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature, message });

    expect(res.status).toBe(401);
    expect((res.body.error ?? res.body).code).toBe('TOKEN_EXPIRED');
    expect(repository.stored).toHaveLength(0);
  });

  it('rejects replayed login challenges with 401', async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();
    const message = createWalletLoginChallenge(walletAddress);
    const signature = keypair.sign(Buffer.from(message, 'utf8')).toString('hex');

    const first = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature, message });
    expect(first.status).toBe(200);

    const replay = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature, message });
    expect(replay.status).toBe(401);
    expect((replay.body.error ?? replay.body).code).toBe('INVALID_TOKEN');
    expect(repository.stored).toHaveLength(1);
  });

  it('enforces IP rate limiting on POST /auth/wallet', async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    for (let i = 0; i < 5; i++) {
      const msg = createWalletLoginChallenge(walletAddress, { nonce: `nonce-${i}` });
      const sig = keypair.sign(Buffer.from(msg, 'utf8')).toString('hex');
      const okRes = await request(walletApp)
        .post('/auth/wallet')
        .send({ walletAddress, signature: sig, message: msg });
      expect(okRes.status).toBe(200);
    }

    const sixthMsg = createWalletLoginChallenge(walletAddress, { nonce: 'nonce-6' });
    const sixthSig = keypair.sign(Buffer.from(sixthMsg, 'utf8')).toString('hex');
    const throttled = await request(walletApp)
      .post('/auth/wallet')
      .send({ walletAddress, signature: sixthSig, message: sixthMsg });

    expect(throttled.status).toBe(429);
    expect((throttled.body.error ?? throttled.body).code).toBe('TOO_MANY_REQUESTS');
  });
});
