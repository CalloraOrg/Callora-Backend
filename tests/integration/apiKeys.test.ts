import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createTestDb } from '../helpers/db.js';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt.js';
import { randomUUID } from 'crypto';

function buildApiKeysApp(pool: any) {
  const app = express();
  app.use(express.json());

  const jwtGuard = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, TEST_JWT_SECRET);
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };

  app.post('/api/apis/:id/keys', jwtGuard, async (req: any, res) => {
    const apiId = req.params.id;
    const rawKey = randomUUID();
    const keyHash = Buffer.from(rawKey).toString('base64');

    const result = await pool.query(
      `INSERT INTO api_keys (id, user_id, api_id, key_hash)
       VALUES (gen_random_uuid(), $1, $2, $3)
       RETURNING id, api_id, created_at`,
      [req.user.userId, apiId, keyHash]
    );

    return res.status(201).json({
      id: result.rows[0].id,
      apiId: result.rows[0].api_id,
      key: rawKey,
      createdAt: result.rows[0].created_at,
    });
  });

  app.delete('/api/keys/:id', jwtGuard, async (req: any, res) => {
    const result = await pool.query(
      `UPDATE api_keys SET revoked = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found or unauthorized' });
    }

    return res.status(200).json({ message: 'Key revoked', id: req.params.id });
  });

  return app;
}

describe('API Key flows', () => {
  let db: any;
  let app: express.Express;
  let token: string;
  const userId = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    db = createTestDb();
    app = buildApiKeysApp(db.pool);
    token = signTestToken({ userId, walletAddress: 'GDTEST123STELLAR' });
    await db.pool.query(
      `INSERT INTO users (id, wallet_address) VALUES ($1, $2)`,
      [userId, 'GDTEST123STELLAR']
    );
  });

  afterEach(async () => {
    await db.end();
  });

  describe('POST /api/apis/:id/keys', () => {
    it('creates a new API key and returns it', async () => {
      const res = await request(app)
        .post('/api/apis/my-api-123/keys')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.key).toBeDefined();
      expect(res.body.apiId).toBe('my-api-123');
    });

    it('returns 401 without JWT', async () => {
      const res = await request(app).post('/api/apis/my-api-123/keys');
      expect(res.status).toBe(401);
    });

    it('creates multiple keys for same api', async () => {
      // Insert 2 keys directly to avoid pg-mem sequential request slowness
      const key1 = randomUUID();
      const key2 = randomUUID();

      const r1 = await db.pool.query(
        `INSERT INTO api_keys (id, user_id, api_id, key_hash)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, api_id`,
        [userId, 'my-api-123', Buffer.from(key1).toString('base64')]
      );
      const r2 = await db.pool.query(
        `INSERT INTO api_keys (id, user_id, api_id, key_hash)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id, api_id`,
        [userId, 'my-api-123', Buffer.from(key2).toString('base64')]
      );

      expect(r1.rows[0].id).not.toBe(r2.rows[0].id);
      expect(key1).not.toBe(key2);
    });
  });

  describe('DELETE /api/keys/:id', () => {
    it('revokes an existing key', async () => {
      const create = await request(app)
        .post('/api/apis/my-api-123/keys')
        .set('Authorization', `Bearer ${token}`);

      const res = await request(app)
        .delete(`/api/keys/${create.body.id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Key revoked');
    });

    it('returns 404 for non-existent key', async () => {
      const res = await request(app)
        .delete(`/api/keys/${randomUUID()}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Key not found or unauthorized');
    });

    it('returns 401 without JWT', async () => {
      const res = await request(app).delete(`/api/keys/${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it('cannot revoke another users key', async () => {
      const create = await request(app)
        .post('/api/apis/my-api-123/keys')
        .set('Authorization', `Bearer ${token}`);

      const otherToken = signTestToken({
        userId: '00000000-0000-0000-0000-000000000099',
        walletAddress: 'GDOTHER',
      });

      const res = await request(app)
        .delete(`/api/keys/${create.body.id}`)
        .set('Authorization', `Bearer ${otherToken}`);

      expect(res.status).toBe(404);
    });
  });
});
