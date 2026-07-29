import request from 'supertest';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import pkg from 'pg';
const { Pool } = pkg;

const TEST_ADMIN_API_KEY = 'test-admin-api-key';

describe('Admin Audit Log Integration Tests (with Testcontainers)', () => {
  let container: StartedTestContainer;
  let pool: any;
  let app: any;

  beforeAll(async () => {
    // 1. Start PostgreSQL container
    container = await new GenericContainer('postgres:15-alpine')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_DB: 'callora_test',
      })
      .start();

    const mappedPort = container.getMappedPort(5432);
    const host = container.getHost();
    const databaseUrl = `postgresql://postgres:postgres@${host}:${mappedPort}/callora_test`;

    // 2. Set environment variables before importing app/db modules
    process.env.DATABASE_URL = databaseUrl;
    process.env.ADMIN_API_KEY = TEST_ADMIN_API_KEY;
    // Disable admin IP allowlist for test execution
    delete process.env.ADMIN_IP_ALLOWED_RANGES;
    delete process.env.ADMIN_IP_ALLOWLIST_ENABLED;

    // 3. Create the database pool and initialize the audit_logs schema
    pool = new Pool({
      connectionString: databaseUrl,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id             VARCHAR(255) PRIMARY KEY,
        event          VARCHAR(255) NOT NULL,
        actor          VARCHAR(255) NOT NULL,
        tenant_id      VARCHAR(255),
        client_ip      VARCHAR(255),
        user_agent     TEXT,
        correlation_id VARCHAR(255),
        body_hash      TEXT,
        details        TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // 4. Dynamically import the app after setting environment variables
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  }, 60000); // Allow 60 seconds for container startup

  afterAll(async () => {
    // Cleanup connection pool and container
    if (pool) {
      await pool.end();
    }
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    // Clear logs table before each test run
    await pool.query('TRUNCATE TABLE audit_logs CASCADE');
  });

  const seedAuditLog = async (log: {
    id: string;
    event: string;
    actor: string;
    tenantId?: string;
    clientIp?: string;
    userAgent?: string;
    correlationId?: string;
    bodyHash?: string;
    details?: any;
    createdAt?: Date;
  }) => {
    await pool.query(
      `
      INSERT INTO audit_logs (
        id, event, actor, tenant_id, client_ip, user_agent,
        correlation_id, body_hash, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))
      `,
      [
        log.id,
        log.event,
        log.actor,
        log.tenantId ?? null,
        log.clientIp ?? null,
        log.userAgent ?? null,
        log.correlationId ?? null,
        log.bodyHash ?? null,
        log.details ? JSON.stringify(log.details) : null,
        log.createdAt ?? null,
      ]
    );
  };

  it('should list audit logs via GET /api/admin/audit', async () => {
    await seedAuditLog({
      id: 'audit-1',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date('2026-07-26T10:00:00.000Z'),
    });

    const res = await request(app)
      .get('/api/admin/audit')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('audit-1');
  });

  it('should filter audit logs by event, actor, and tenant_id', async () => {
    await seedAuditLog({
      id: 'audit-1',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      tenantId: 'tenant-1',
    });
    await seedAuditLog({
      id: 'audit-2',
      event: 'RESET_USAGE_AGGREGATE',
      actor: 'another-actor',
      tenantId: 'tenant-2',
    });

    const res1 = await request(app)
      .get('/api/admin/audit?event=LIST_USERS')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);
    expect(res1.status).toBe(200);
    expect(res1.body.data).toHaveLength(1);
    expect(res1.body.data[0].id).toBe('audit-1');

    const res2 = await request(app)
      .get('/api/admin/audit?actor=another-actor')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0].id).toBe('audit-2');

    const res3 = await request(app)
      .get('/api/admin/audit?tenant_id=tenant-1')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);
    expect(res3.status).toBe(200);
    expect(res3.body.data).toHaveLength(1);
    expect(res3.body.data[0].id).toBe('audit-1');
  });

  it('should support pagination via limit and cursor', async () => {
    await seedAuditLog({
      id: 'audit-1',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date('2026-07-26T10:00:00.000Z'),
    });
    await seedAuditLog({
      id: 'audit-2',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date('2026-07-26T10:05:00.000Z'),
    });
    await seedAuditLog({
      id: 'audit-3',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date('2026-07-26T10:10:00.000Z'),
    });

    const res1 = await request(app)
      .get('/api/admin/audit?limit=2')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res1.status).toBe(200);
    expect(res1.body.data).toHaveLength(2);
    // Keysorted DESC: audit-3, then audit-2
    expect(res1.body.data[0].id).toBe('audit-3');
    expect(res1.body.data[1].id).toBe('audit-2');
    expect(res1.body.meta.hasMore).toBe(true);
    expect(res1.body.meta.nextCursor).toBeDefined();

    const res2 = await request(app)
      .get(`/api/admin/audit?limit=2&cursor=${res1.body.meta.nextCursor}`)
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(1);
    expect(res2.body.data[0].id).toBe('audit-1');
    expect(res2.body.meta.hasMore).toBe(false);
  });

  it('should filter by from and to dates', async () => {
    await seedAuditLog({
      id: 'audit-1',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date('2026-07-26T10:00:00.000Z'),
    });
    await seedAuditLog({
      id: 'audit-2',
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date('2026-07-26T11:00:00.000Z'),
    });

    const res = await request(app)
      .get('/api/admin/audit?from=2026-07-26T10:30:00.000Z&to=2026-07-26T11:30:00.000Z')
      .set('x-admin-api-key', TEST_ADMIN_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('audit-2');
  });

  it('should reject requests without admin API key', async () => {
    const res = await request(app).get('/api/admin/audit');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
