import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const originalSqlitePath = process.env.SQLITE_PATH;

describe('defaultSubscriptionRepository (SQLite)', () => {
  let dbModule!: typeof import('../db/index.js');
  let repository!: typeof import('./subscriptionRepository.js').defaultSubscriptionRepository;
  let deserialiseRetryPolicy!: typeof import('./subscriptionRepository.js').deserialiseRetryPolicy;
  let apiId: number;
  let secondApiId: number;

  beforeAll(async () => {
    process.env.SQLITE_PATH = ':memory:';
    dbModule = await import('../db/index.js');

    // Apply only the relevant migrations because unrelated unprefixed files
    // prevent initializeDb() from discovering the full migration directory.
    const migrationsDir = path.join(process.cwd(), 'migrations');
    for (const filename of [
      '0000_initial_apis_tables.sql',
      '0004_create_developers.sql',
      '0018_subscriptions.sql',
      '0020_subscription_retry_policy.sql',
    ]) {
      dbModule.sqlite.exec(
        fs.readFileSync(path.join(migrationsDir, filename), 'utf8'),
      );
    }
    dbModule.sqlite.pragma('foreign_keys = ON');

    const repositoryModule = await import('./subscriptionRepository.js');
    repository = repositoryModule.defaultSubscriptionRepository;
    deserialiseRetryPolicy = repositoryModule.deserialiseRetryPolicy;

    const developerId = Number(
      dbModule.sqlite
        .prepare('INSERT INTO developers (user_id) VALUES (?)')
        .run('subscription-repository-test-developer').lastInsertRowid,
    );
    const insertApi = dbModule.sqlite.prepare(
      'INSERT INTO apis (developer_id, name, base_url) VALUES (?, ?, ?)',
    );
    apiId = Number(
      insertApi.run(
        developerId,
        'Subscription Test API',
        'https://subscription.example.com',
      ).lastInsertRowid,
    );
    secondApiId = Number(
      insertApi.run(
        developerId,
        'Second Subscription Test API',
        'https://second-subscription.example.com',
      ).lastInsertRowid,
    );
  });

  beforeEach(async () => {
    await dbModule.db.delete(dbModule.schema.subscriptions);
  });

  afterAll(async () => {
    await dbModule.closeDb();
    if (originalSqlitePath === undefined) {
      delete process.env.SQLITE_PATH;
    } else {
      process.env.SQLITE_PATH = originalSqlitePath;
    }
  });

  it('creates default and customized subscriptions and finds them by id', async () => {
    const defaults = await repository.create({
      user_id: 'subscription-default-user',
      api_id: apiId,
    });

    expect(defaults).toMatchObject({
      user_id: 'subscription-default-user',
      api_id: apiId,
      status: 'active',
      metering_limit: null,
      retry_policy: null,
    });
    expect(await repository.findById(defaults.id)).toMatchObject({
      id: defaults.id,
      user_id: defaults.user_id,
      api_id: apiId,
    });

    const customPolicy = { maxRetries: 0, baseDelayMs: 250 };
    const customized = await repository.create({
      user_id: 'subscription-custom-user',
      api_id: secondApiId,
      metering_limit: 0,
      retry_policy: customPolicy,
    });
    expect(customized.metering_limit).toBe(0);
    expect(customized.retry_policy).toBe(JSON.stringify(customPolicy));

    await expect(repository.findById('missing-subscription')).resolves.toBeUndefined();
  });

  it('returns only a user’s subscriptions in creation order', async () => {
    const first = await repository.create({
      user_id: 'subscription-order-user',
      api_id: apiId,
    });
    const second = await repository.create({
      user_id: 'subscription-order-user',
      api_id: secondApiId,
    });
    await repository.create({
      user_id: 'different-subscription-user',
      api_id: apiId,
    });

    await dbModule.db
      .update(dbModule.schema.subscriptions)
      .set({ created_at: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(dbModule.schema.subscriptions.id, first.id));
    await dbModule.db
      .update(dbModule.schema.subscriptions)
      .set({ created_at: new Date('2026-01-01T00:00:02.000Z') })
      .where(eq(dbModule.schema.subscriptions.id, second.id));

    const subscriptions = await repository.findByUserId('subscription-order-user');
    expect(subscriptions.map((subscription) => subscription.id)).toEqual([
      first.id,
      second.id,
    ]);
    await expect(repository.findByUserId('no-subscriptions-user')).resolves.toEqual([]);
  });

  it('finds active and paused subscriptions, excludes other users and APIs, and permits re-subscribing after cancel', async () => {
    const active = await repository.create({
      user_id: 'subscription-status-user',
      api_id: apiId,
    });
    expect(
      await repository.findActiveByUserAndApi('subscription-status-user', apiId),
    ).toMatchObject({ id: active.id, status: 'active' });
    await expect(
      repository.findActiveByUserAndApi('different-subscription-user', apiId),
    ).resolves.toBeUndefined();
    await expect(
      repository.findActiveByUserAndApi('subscription-status-user', secondApiId),
    ).resolves.toBeUndefined();

    const paused = await repository.update(active.id, { status: 'paused' });
    expect(paused?.status).toBe('paused');
    expect(
      await repository.findActiveByUserAndApi('subscription-status-user', apiId),
    ).toMatchObject({ id: active.id, status: 'paused' });

    await repository.cancel(active.id);
    await expect(
      repository.findActiveByUserAndApi('subscription-status-user', apiId),
    ).resolves.toBeUndefined();

    const replacement = await repository.create({
      user_id: 'subscription-status-user',
      api_id: apiId,
    });
    expect(replacement.id).not.toBe(active.id);
    expect(
      await repository.findActiveByUserAndApi('subscription-status-user', apiId),
    ).toMatchObject({ id: replacement.id, status: 'active' });
  });

  it('updates status and nullable fields, preserves omitted fields, and advances updated_at', async () => {
    const initialPolicy = { maxRetries: 3, baseDelayMs: 500 };
    const updatedPolicy = { maxRetries: 5, baseDelayMs: 1000 };
    const created = await repository.create({
      user_id: 'subscription-update-user',
      api_id: apiId,
      metering_limit: 42,
      retry_policy: initialPolicy,
    });

    await dbModule.db
      .update(dbModule.schema.subscriptions)
      .set({ updated_at: new Date(0) })
      .where(eq(dbModule.schema.subscriptions.id, created.id));
    const beforeUpdate = await repository.findById(created.id);
    const paused = await repository.update(created.id, {
      status: 'paused',
      metering_limit: 0,
      retry_policy: updatedPolicy,
    });
    expect(paused).toMatchObject({
      status: 'paused',
      metering_limit: 0,
      retry_policy: JSON.stringify(updatedPolicy),
    });
    expect(paused!.updated_at.getTime()).toBeGreaterThan(
      beforeUpdate!.updated_at.getTime(),
    );

    const resumed = await repository.update(created.id, {
      status: 'active',
      metering_limit: undefined,
      retry_policy: undefined,
    });
    expect(resumed).toMatchObject({
      status: 'active',
      metering_limit: 0,
      retry_policy: JSON.stringify(updatedPolicy),
    });

    const cleared = await repository.update(created.id, {
      metering_limit: null,
      retry_policy: null,
    });
    expect(cleared).toMatchObject({
      status: 'active',
      metering_limit: null,
      retry_policy: null,
    });
    await expect(
      repository.update('missing-subscription', { status: 'paused' }),
    ).resolves.toBeUndefined();
  });

  it('cancels a subscription idempotently and returns undefined for a missing id', async () => {
    const created = await repository.create({
      user_id: 'subscription-cancel-user',
      api_id: apiId,
    });

    const cancelled = await repository.cancel(created.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled?.cancelled_at).toBeInstanceOf(Date);

    const cancelledAgain = await repository.cancel(created.id);
    expect(cancelledAgain).toMatchObject({ id: created.id, status: 'cancelled' });
    expect(cancelledAgain?.cancelled_at).toBeInstanceOf(Date);
    await expect(repository.cancel('missing-subscription')).resolves.toBeUndefined();
  });

  it('keeps malformed stored retry policy readable and deserializes it as null', async () => {
    const created = await repository.create({
      user_id: 'subscription-invalid-policy-user',
      api_id: apiId,
    });
    await dbModule.db
      .update(dbModule.schema.subscriptions)
      .set({ retry_policy: '{invalid-json' })
      .where(eq(dbModule.schema.subscriptions.id, created.id));

    const found = await repository.findById(created.id);
    expect(found?.retry_policy).toBe('{invalid-json');
    expect(deserialiseRetryPolicy(found?.retry_policy)).toBeNull();
  });
});
