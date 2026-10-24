import assert from 'node:assert/strict';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import pkg from 'pg';
import {
  PgQuotaNotificationStore,
  runQuotaCheck,
  type QuotaNotificationDb,
} from '../../src/services/quotaNotifier.js';
import type { UsageEventsRepository } from '../../src/repositories/usageEventsRepository.js';
import { WebhookStore } from '../../src/webhooks/webhook.store.js';
import { resetWebhookDispatcherForTests } from '../../src/webhooks/webhook.dispatcher.js';

const { Pool } = pkg;

jest.mock('dns/promises', () => ({
  __esModule: true,
  default: {
    lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

describe('Quota notifier PostgreSQL concurrency', () => {
  let container: StartedTestContainer;
  let firstPool: InstanceType<typeof Pool> | undefined;
  let secondPool: InstanceType<typeof Pool> | undefined;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_DB: 'callora_test',
      })
      .start();

    const connectionString =
      `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/callora_test`;
    firstPool = new Pool({ connectionString });
    secondPool = new Pool({ connectionString });

    await firstPool.query(`
      CREATE TABLE quota_notifications_sent (
        developer_id VARCHAR(255) NOT NULL,
        period CHAR(7) NOT NULL,
        threshold SMALLINT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (developer_id, period, threshold)
      )
    `);
  }, 60000);

  afterAll(async () => {
    await Promise.all([firstPool?.end(), secondPool?.end()]);
    await container?.stop();
  });

  beforeEach(() => {
    WebhookStore.clear();
    resetWebhookDispatcherForTests();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    WebhookStore.clear();
  });

  it('claims each threshold once across two concurrent runs using separate pools', async () => {
    const deliveries: Array<{ threshold: number }> = [];
    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { data: { threshold: number } };
      deliveries.push(payload.data);
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }) as typeof global.fetch;

    WebhookStore.register({
      developerId: 'dev-concurrent',
      url: 'https://example.com/quota',
      events: ['quota.threshold.reached'],
      createdAt: new Date(),
    });

    const usageRepo = {
      countByDeveloper: async () => 100,
    } as unknown as UsageEventsRepository;
    const now = () => new Date('2026-06-15T12:00:00.000Z');
    const quotas = async () => [{ developerId: 'dev-concurrent', monthlyLimit: 100 }];
    const firstStore = new PgQuotaNotificationStore(firstPool as unknown as QuotaNotificationDb);
    const secondStore = new PgQuotaNotificationStore(secondPool as unknown as QuotaNotificationDb);

    const outcomes = await Promise.all([
      runQuotaCheck({
        usageRepo,
        notificationStore: firstStore,
        getDeveloperQuotas: quotas,
        now,
        logger: { error: jest.fn(), info: jest.fn() },
      }),
      runQuotaCheck({
        usageRepo,
        notificationStore: secondStore,
        getDeveloperQuotas: quotas,
        now,
        logger: { error: jest.fn(), info: jest.fn() },
      }),
    ]);

    assert.equal(outcomes.reduce((total, outcome) => total + outcome.claimed, 0), 3);
    assert.equal(outcomes.reduce((total, outcome) => total + outcome.dispatched, 0), 3);
    assert.equal(outcomes.reduce((total, outcome) => total + outcome.noSubscribers, 0), 0);
    assert.deepEqual(deliveries.map(({ threshold }) => threshold).sort((a, b) => a - b), [80, 95, 100]);

    const result = await firstPool?.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM quota_notifications_sent',
    );
    assert.equal(result?.rows[0]?.count, 3);
  }, 60000);
});
