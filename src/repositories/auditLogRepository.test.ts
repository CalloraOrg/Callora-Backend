import assert from 'node:assert/strict';
import { DataType, newDb } from 'pg-mem';

jest.mock('../config/env', () => ({
  env: {
    PORT: 3000,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/callora_test',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'callora_test',
    DB_POOL_MAX: 1,
    DB_IDLE_TIMEOUT_MS: 1000,
    DB_CONN_TIMEOUT_MS: 1000,
    JWT_SECRET: 'test-jwt-secret',
    ADMIN_API_KEY: 'test-admin-api-key',
    METRICS_API_KEY: 'test-metrics-api-key',
    UPSTREAM_URL: 'http://localhost:4000',
    PROXY_TIMEOUT_MS: 30000,
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    SOROBAN_RPC_ENABLED: false,
    HORIZON_ENABLED: false,
    STELLAR_TESTNET_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_MAINNET_HORIZON_URL: 'https://horizon.stellar.org',
    SOROBAN_TESTNET_RPC_URL: 'https://soroban-testnet.stellar.org',
    SOROBAN_MAINNET_RPC_URL: 'https://soroban-mainnet.stellar.org',
    STELLAR_BASE_FEE: 100,
    HEALTH_CHECK_DB_TIMEOUT: 2000,
    APP_VERSION: '1.0.0',
    LOG_LEVEL: 'info',
    GATEWAY_PROFILING_ENABLED: false,
  },
}));

import {
  PgAuditLogRepository,
  type AuditLogRepositoryQueryable,
} from './auditLogRepository.js';
import { encodeCursor } from '../lib/cursorPagination.js';

function createAuditLogRepository() {
  const db = newDb();

  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date('2026-06-28T00:00:00.000Z'),
  });

  db.public.none(`
    CREATE TABLE audit_logs (
      id VARCHAR(255) PRIMARY KEY,
      event VARCHAR(255) NOT NULL,
      actor VARCHAR(255) NOT NULL,
      tenant_id VARCHAR(255),
      client_ip VARCHAR(255),
      user_agent TEXT,
      correlation_id VARCHAR(255),
      body_hash TEXT,
      details TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pgPool = new Pool();

  return {
    repository: new PgAuditLogRepository(pgPool as AuditLogRepositoryQueryable),
    pgPool,
    queryable: pgPool as AuditLogRepositoryQueryable,
    db,
  };
}

async function insertAuditLog(
  pool: AuditLogRepositoryQueryable,
  values: {
    id: string;
    event: string;
    actor: string;
    tenantId?: string | null;
    createdAt: Date;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `
      INSERT INTO audit_logs (
        id, event, actor, tenant_id, client_ip, user_agent,
        correlation_id, body_hash, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      values.id,
      values.event,
      values.actor,
      values.tenantId ?? null,
      '127.0.0.1',
      'jest',
      `req-${values.id}`,
      null,
      values.details ? JSON.stringify(values.details) : null,
      values.createdAt,
    ],
  );
}

async function seedAuditLogs(
  pool: AuditLogRepositoryQueryable,
  count: number,
  baseTime = new Date('2026-06-28T00:00:00.000Z'),
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await insertAuditLog(pool, {
      id: `audit-${String(i).padStart(3, '0')}`,
      event: 'LIST_USERS',
      actor: 'admin-api-key',
      createdAt: new Date(baseTime.getTime() + i * 60_000),
      details: { index: i },
    });
  }
}

test('returns newest rows first with next page detection', async () => {
  const { repository, pgPool, queryable } = createAuditLogRepository();

  try {
    await seedAuditLogs(queryable, 5);

    const firstPage = await repository.findCursor({ limit: 2 });
    assert.equal(firstPage.entries.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.entries[0]?.id, 'audit-004');
    assert.equal(firstPage.entries[1]?.id, 'audit-003');

    const cursor = encodeCursor(
      new Date(firstPage.entries[1]!.createdAt),
      firstPage.entries[1]!.id,
    );

    const secondPage = await repository.findCursor({
      limit: 2,
      afterCursor: {
        timestamp: new Date(firstPage.entries[1]!.createdAt),
        id: firstPage.entries[1]!.id,
      },
    });

    assert.equal(secondPage.entries.length, 2);
    assert.equal(secondPage.hasMore, true);
    assert.equal(secondPage.entries[0]?.id, 'audit-002');
    assert.equal(secondPage.entries[1]?.id, 'audit-001');
    assert.notEqual(cursor, '');
  } finally {
    await pgPool.end();
  }
});

test('returns hasMore=false on the final page', async () => {
  const { repository, pgPool, queryable } = createAuditLogRepository();

  try {
    await seedAuditLogs(queryable, 3);

    const page = await repository.findCursor({
      limit: 1,
      afterCursor: {
        timestamp: new Date('2026-06-28T00:01:00.000Z'),
        id: 'audit-001',
      },
    });

    assert.equal(page.entries.length, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.entries[0]?.id, 'audit-000');
  } finally {
    await pgPool.end();
  }
});

test('applies event and tenant filters', async () => {
  const { repository, pgPool, queryable } = createAuditLogRepository();

  try {
    await queryable.query(
      `
        INSERT INTO audit_logs (id, event, actor, tenant_id, created_at)
        VALUES
          ('a-1', 'LIST_USERS', 'admin-api-key', 'tenant-a', '2026-06-28T01:00:00.000Z'),
          ('a-2', 'SOFT_DELETE_API', 'admin-api-key', 'tenant-b', '2026-06-28T02:00:00.000Z')
      `,
    );

    const filtered = await repository.findCursor({
      limit: 10,
      event: 'SOFT_DELETE_API',
      tenantId: 'tenant-b',
    });

    assert.equal(filtered.entries.length, 1);
    assert.equal(filtered.entries[0]?.id, 'a-2');
    assert.equal(filtered.hasMore, false);
  } finally {
    await pgPool.end();
  }
});

test('parses JSON details into objects', async () => {
  const { repository, pgPool, queryable } = createAuditLogRepository();

  try {
    await seedAuditLogs(queryable, 1);
    const page = await repository.findCursor({ limit: 1 });

    assert.deepEqual(page.entries[0]?.details, { index: 0 });
  } finally {
    await pgPool.end();
  }
});
