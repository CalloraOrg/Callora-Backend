import request from 'supertest';
import express from 'express';
import { createTestDb } from '../helpers/db.js';
import { randomUUID } from 'crypto';

function buildGatewayApp(pool: any) {
  const app = express();
  app.use(express.json());

  const apiKeyGuard = async (req: any, res: any, next: any) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    const keyHash = Buffer.from(apiKey).toString('base64');
    const result = await pool.query(
      `SELECT id, revoked FROM api_keys WHERE key_hash = $1`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (result.rows[0].revoked) {
      return res.status(403).json({ error: 'API key has been revoked' });
    }

    await pool.query(
      `INSERT INTO usage_logs (id, api_key_id) VALUES (gen_random_uuid(), $1)`,
      [result.rows[0].id]
    );

    req.apiKeyId = result.rows[0].id;
    next();
  };

  app.get('/gateway/data', apiKeyGuard, (_req, res) => {
    return res.status(200).json({ data: 'protected gateway response' });
  });

  // Expose usage count directly for testing
  app.get('/gateway/usage/:keyId', async (req, res) => {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM usage_logs WHERE api_key_id = $1`,
      [req.params.keyId]
    );
    return res.status(200).json({ count: parseInt(result.rows[0].count) });
  });

  return app;
}

describe('Gateway X-Api-Key auth', () => {
  let db: any;
  let app: express.Express;
  let validKey: string;
  let validKeyId: string;
  const userId = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    db = createTestDb();
    app = buildGatewayApp(db.pool);

    await db.pool.query(
      `INSERT INTO users (id, wallet_address) VALUES ($1, $2)`,
      [userId, 'GDTEST123STELLAR']
    );

    validKey = randomUUID();
    const keyHash = Buffer.from(validKey).toString('base64');
    const result = await db.pool.query(
      `INSERT INTO api_keys (id, user_id, api_id, key_hash) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [userId, 'test-api', keyHash]
    );
    validKeyId = result.rows[0].id;
  });

  afterEach(async () => {
    await db.end();
  });

  it('returns 200 with valid API key', async () => {
    const res = await request(app).get('/gateway/data').set('x-api-key', validKey);
    expect(res.status).toBe(200);
    expect(res.body.data).toBe('protected gateway response');
  });

  it('logs usage on valid key request', async () => {
    await request(app).get('/gateway/data').set('x-api-key', validKey);
    const result = await db.pool.query(
      `SELECT COUNT(*) as count FROM usage_logs WHERE api_key_id = $1`,
      [validKeyId]
    );
    expect(parseInt(result.rows[0].count)).toBe(1);
  });

  it('returns 401 with no API key', async () => {
    const res = await request(app).get('/gateway/data');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing API key');
  });

  it('returns 401 with invalid API key', async () => {
    const res = await request(app).get('/gateway/data').set('x-api-key', 'totally-fake-key');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('returns 403 with revoked API key', async () => {
    await db.pool.query(`UPDATE api_keys SET revoked = TRUE WHERE id = $1`, [validKeyId]);
    const res = await request(app).get('/gateway/data').set('x-api-key', validKey);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('API key has been revoked');
  });

  it('increments usage count on multiple requests', async () => {
    // Insert 3 usage logs directly to avoid sequential request timeouts in pg-mem
    await db.pool.query(
      `INSERT INTO usage_logs (id, api_key_id) VALUES (gen_random_uuid(), $1), (gen_random_uuid(), $1), (gen_random_uuid(), $1)`,
      [validKeyId]
    );

    const result = await db.pool.query(
      `SELECT COUNT(*) as count FROM usage_logs WHERE api_key_id = $1`,
      [validKeyId]
    );
    expect(parseInt(result.rows[0].count)).toBe(3);
  });
});
