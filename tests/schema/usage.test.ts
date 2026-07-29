/**
 * Response schema stability test for GET /api/usage
 *
 * Snapshot tests that assert the /api/usage response shape doesn't drift
 * accidentally across code changes. Uses inline snapshots to lock down the
 * expected response schema keys and types.
 *
 * Closes #778
 */

// Set env vars BEFORE imports so createApp picks them up
process.env.JWT_SECRET = 'test-schema-usage-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.METRICS_API_KEY = 'test-metrics-key';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { InMemoryUsageEventsRepository, type UsageEvent } from '../../src/repositories/usageEventsRepository.js';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));

// Mock better-sqlite3 to prevent native binding errors
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

// Bypass startup env-var validation
jest.mock('../../src/config/env', () => ({
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
    JWT_SECRET: 'test-schema-usage-secret',
    ADMIN_API_KEY: 'test-admin-key',
    METRICS_API_KEY: 'test-metrics-key',
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

const TEST_JWT_SECRET = 'test-schema-usage-secret';

function generateToken(role = 'developer', sub = 'user123'): string {
  return jwt.sign({ role, sub }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

// Use recent dates so events fall within the default 30-day usage window.
const now = new Date();
const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

const mockEvents: UsageEvent[] = [
  {
    id: 'event1',
    developerId: 'dev1',
    apiId: 'api1',
    endpoint: '/api1/endpoint1',
    userId: 'user123',
    occurredAt: twoDaysAgo,
    revenue: BigInt('1000000'),
  },
  {
    id: 'event2',
    developerId: 'dev1',
    apiId: 'api1',
    endpoint: '/api1/endpoint2',
    userId: 'user123',
    occurredAt: oneDayAgo,
    revenue: BigInt('2000000'),
  },
];

describe('GET /api/usage — Response Schema Stability', () => {
  let usageRepo: InMemoryUsageEventsRepository;

  beforeEach(() => {
    usageRepo = new InMemoryUsageEventsRepository(mockEvents);
  });

  describe('200 response shape', () => {
    it('returns the expected top-level response keys (events, stats, period)', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      const topLevelKeys = Object.keys(response.body).sort();
      expect(topLevelKeys).toMatchInlineSnapshot(`
[
  "events",
  "pagination",
  "period",
  "requestId",
  "stats",
]
`);
    });

    it('returns events with the correct shape', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      expect(response.body.events).toHaveLength(2);
      for (const event of response.body.events) {
        expect(Object.keys(event).sort()).toEqual([
          'apiId',
          'endpoint',
          'id',
          'occurredAt',
          'revenue',
        ]);
        expect(typeof event.id).toBe('string');
        expect(typeof event.apiId).toBe('string');
        expect(typeof event.endpoint).toBe('string');
        expect(typeof event.occurredAt).toBe('string');
        expect(typeof event.revenue).toBe('string');
      }
    });

    it('returns stats with the correct shape', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      const statsKeys = Object.keys(response.body.stats).sort();
      expect(statsKeys).toEqual([
        'breakdownByApi',
        'totalCalls',
        'totalSpent',
      ]);

      expect(typeof response.body.stats.totalCalls).toBe('number');
      expect(typeof response.body.stats.totalSpent).toBe('string');

      for (const item of response.body.stats.breakdownByApi) {
        expect(Object.keys(item).sort()).toEqual(['apiId', 'calls', 'revenue']);
        expect(typeof item.apiId).toBe('string');
        expect(typeof item.calls).toBe('number');
        expect(typeof item.revenue).toBe('string');
      }
    });

    it('returns period with the correct shape', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      expect(Object.keys(response.body.period).sort()).toEqual(['from', 'to']);
      expect(typeof response.body.period.from).toBe('string');
      expect(typeof response.body.period.to).toBe('string');
      // Should be valid ISO date strings
      expect(new Date(response.body.period.from).getTime()).not.toBeNaN();
      expect(new Date(response.body.period.to).getTime()).not.toBeNaN();
    });

    it('returns pagination with the correct shape', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      expect(Object.keys(response.body.pagination).sort()).toEqual([
        'hasMore',
        'limit',
        'offset',
      ]);
      expect(typeof response.body.pagination.hasMore).toBe('boolean');
      expect(typeof response.body.pagination.limit).toBe('number');
      expect(typeof response.body.pagination.offset).toBe('number');
    });
  });

  describe('snapshot tests — full response', () => {
    it('matches the full usage response schema snapshot', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      // Assert top-level shape as an explicit snapshot of keys/types,
      // avoiding inline-snapshot formatting differences across environments.
      expect({
        keys: Object.keys(response.body).sort(),
        eventsType: typeof response.body.events,
        statsType: typeof response.body.stats,
        periodType: typeof response.body.period,
        paginationType: typeof response.body.pagination,
      }).toMatchSnapshot('usage-response-top-level-shape');

      // Strip variable values for a stable structural snapshot.
      const stabilized = {
        ...response.body,
        period: { from: '<PERIOD_FROM>', to: '<PERIOD_TO>' },
        events: response.body.events.map(
          (e: Record<string, unknown>) => ({
            ...e,
            id: '<EVENT_ID>',
            occurredAt: '<OCCURRED_AT>',
          }),
        ),
      };

      expect(stabilized).toMatchSnapshot('usage-response-schema');
    });

    it('returns empty events array and zero stats for user with no events', async () => {
      const emptyRepo = new InMemoryUsageEventsRepository([]);
      const app = createApp({ usageEventsRepository: emptyRepo });

      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${generateToken()}`)
        .expect(200);

      expect(response.body.events).toEqual([]);
      expect(response.body.stats.totalCalls).toBe(0);
      expect(response.body.stats.totalSpent).toBe('0');
      expect(response.body.stats.breakdownByApi).toEqual([]);
    });

    it('returns 401 error with consistent error shape when unauthenticated', async () => {
      const app = createApp({ usageEventsRepository: usageRepo });

      const response = await request(app)
        .get('/api/usage')
        .expect(401);

      // Error shape stability check — uses standard error envelope.
      expect(response.body.success).toBe(false);
      expect(typeof response.body.requestId).toBe('string');
      expect(typeof response.body.timestamp).toBe('string');
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(typeof response.body.error.message).toBe('string');
    });
  });
});
