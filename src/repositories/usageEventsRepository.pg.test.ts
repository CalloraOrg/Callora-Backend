import assert from 'node:assert/strict';
import { DataType, newDb } from 'pg-mem';

import {
  PgUsageEventsRepository,
  type UsageEventsRepositoryQueryable,
} from './usageEventsRepository.pg.js';

function createUsageEventsRepository() {
  const db = newDb();

  db.public.registerFunction({
    name: 'now',
    returns: DataType.timestamp,
    implementation: () => new Date('2026-03-01T00:00:00.000Z'),
  });

  db.public.none(`
    CREATE TABLE usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      api_id VARCHAR(255) NOT NULL,
      endpoint_id VARCHAR(255) NOT NULL,
      api_key_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL DEFAULT '',
      amount_usdc NUMERIC(20, 0) NOT NULL,
      request_id VARCHAR(255) NOT NULL,
      stellar_tx_hash VARCHAR(64),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (request_id, developer_id)
    );

    CREATE TABLE revenue_ledger (
      id BIGSERIAL PRIMARY KEY,
      api_id VARCHAR(255) NOT NULL,
      developer_id VARCHAR(255) NOT NULL,
      amount_usdc NUMERIC(20, 0) NOT NULL,
      usage_event_id BIGINT UNIQUE REFERENCES usage_events(id),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_usage_events_user_created ON usage_events(user_id, created_at);
    CREATE INDEX idx_usage_events_api_created ON usage_events(api_id, created_at);
    CREATE INDEX idx_usage_events_developer_created ON usage_events(developer_id, created_at);
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    repository: new PgUsageEventsRepository(pool as UsageEventsRepositoryQueryable),
    pool,
  };
}

test('create stores a usage event and returns the persisted record', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    const createdAt = new Date('2026-02-01T09:30:00.000Z');
    const event = await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-current',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 1250n,
      requestId: 'req-1',
      stellarTxHash: 'stellar-hash-1',
      createdAt,
    });

    assert.equal(event.id, '1');
    assert.equal(event.userId, 'user-1');
    assert.equal(event.apiId, 'api-weather');
    assert.equal(event.endpointId, 'endpoint-current');
    assert.equal(event.apiKeyId, 'key-1');
    assert.equal(event.developerId, 'dev-1');
    assert.equal(event.amount, 1250n);
    assert.equal(event.requestId, 'req-1');
    assert.equal(event.stellarTxHash, 'stellar-hash-1');
    assert.deepEqual(event.createdAt, createdAt);
  } finally {
    await pool.end();
  }
});

test('create is idempotent on requestId and returns the existing row on conflict', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    const first = await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-current',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 1250n,
      requestId: 'req-duplicate',
      stellarTxHash: 'stellar-hash-1',
      createdAt: new Date('2026-02-01T09:30:00.000Z'),
    });

    const duplicate = await repository.create({
      userId: 'user-2',
      apiId: 'api-other',
      endpointId: 'endpoint-other',
      apiKeyId: 'key-2',
      developerId: 'dev-1',
      amount: 9999n,
      requestId: 'req-duplicate',
      stellarTxHash: 'stellar-hash-2',
      createdAt: new Date('2026-02-02T09:30:00.000Z'),
    });

    const countResult = await pool.query('SELECT COUNT(*)::text AS count FROM usage_events');

    assert.deepEqual(duplicate, first);
    assert.equal(countResult.rows[0]?.count, '1');
  } finally {
    await pool.end();
  }
});

test('create uses the database default timestamp when createdAt is omitted', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    const before = new Date();
    const event = await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-current',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 500n,
      requestId: 'req-default-time',
    });
    const after = new Date();

    assert.ok(event.createdAt instanceof Date);
    assert.ok(event.createdAt >= before);
    assert.ok(event.createdAt <= after);
    assert.equal(event.stellarTxHash, null);
  } finally {
    await pool.end();
  }
});

test('countByDeveloper counts rows in a half-open UTC month range by developer_id', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    for (const [requestId, developerId, createdAt] of [
      ['req-count-start', 'dev-1', '2026-02-01T00:00:00.000Z'],
      ['req-count-end-minus-ms', 'dev-1', '2026-02-28T23:59:59.999Z'],
      ['req-count-next-month', 'dev-1', '2026-03-01T00:00:00.000Z'],
      ['req-count-other-developer', 'dev-2', '2026-02-15T00:00:00.000Z'],
    ]) {
      await repository.create({
        userId: 'user-1',
        apiId: 'api-weather',
        endpointId: 'endpoint-current',
        apiKeyId: 'key-1',
        developerId,
        amount: 1n,
        requestId,
        createdAt: new Date(createdAt),
      });
    }

    assert.equal(
      await repository.countByDeveloper({
        developerId: 'dev-1',
        from: new Date('2026-02-01T00:00:00.000Z'),
        to: new Date('2026-03-01T00:00:00.000Z'),
      }),
      2,
    );
  } finally {
    await pool.end();
  }
});

test('findByUserId filters by time range, sorts newest first, and honors limit', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-u-1',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-1',
      apiId: 'api-chat',
      endpointId: 'endpoint-2',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 200n,
      requestId: 'req-u-2',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-1',
      apiId: 'api-chat',
      endpointId: 'endpoint-3',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 300n,
      requestId: 'req-u-3',
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-2',
      apiId: 'api-chat',
      endpointId: 'endpoint-4',
      apiKeyId: 'key-2',
      developerId: 'dev-1',
      amount: 400n,
      requestId: 'req-u-4',
      createdAt: new Date('2026-02-04T10:00:00.000Z'),
    });

    const events = await repository.findByUserId(
      'user-1',
      new Date('2026-02-02T00:00:00.000Z'),
      new Date('2026-02-03T23:59:59.999Z'),
      2,
    );

    assert.deepEqual(
      events.map((event) => ({
        requestId: event.requestId,
        amount: event.amount,
      })),
      [
        { requestId: 'req-u-3', amount: 300n },
        { requestId: 'req-u-2', amount: 200n },
      ],
    );
  } finally {
    await pool.end();
  }
});

test('findByApiId filters by time range and returns an empty list for limit 0', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-a-1',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-2',
      apiId: 'api-weather',
      endpointId: 'endpoint-2',
      apiKeyId: 'key-2',
      developerId: 'dev-1',
      amount: 150n,
      requestId: 'req-a-2',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-3',
      apiId: 'api-chat',
      endpointId: 'endpoint-3',
      apiKeyId: 'key-3',
      developerId: 'dev-1',
      amount: 999n,
      requestId: 'req-a-3',
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
    });

    const filtered = await repository.findByApiId(
      'api-weather',
      new Date('2026-02-02T00:00:00.000Z'),
      new Date('2026-02-02T23:59:59.999Z'),
      5,
    );
    const empty = await repository.findByApiId('api-weather', undefined, undefined, 0);

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.requestId, 'req-a-2');
    assert.deepEqual(empty, []);
  } finally {
    await pool.end();
  }
});

test('aggregate helpers sum the smallest-unit amounts and return 0 when no rows match', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-s-1',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-2',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 150n,
      requestId: 'req-s-2',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-2',
      apiId: 'api-weather',
      endpointId: 'endpoint-3',
      apiKeyId: 'key-2',
      developerId: 'dev-1',
      amount: 700n,
      requestId: 'req-s-3',
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
    });

    const totalSpent = await repository.getTotalSpentByUser(
      'user-1',
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-02-02T23:59:59.999Z'),
    );
    const totalRevenue = await repository.getTotalRevenueByApi(
      'api-weather',
      new Date('2026-02-02T00:00:00.000Z'),
      new Date('2026-02-03T23:59:59.999Z'),
    );
    const emptyTotal = await repository.getTotalSpentByUser('missing-user');

    assert.equal(totalSpent, 250n);
    assert.equal(totalRevenue, 850n);
    assert.equal(emptyTotal, 0n);
  } finally {
    await pool.end();
  }
});

test('repository validates blank identifiers, invalid ranges, negative amounts, and invalid limits', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await assert.rejects(
      repository.create({
        userId: '   ',
        apiId: 'api-weather',
        endpointId: 'endpoint-1',
        apiKeyId: 'key-1',
        developerId: 'dev-1',
        amount: 100n,
        requestId: 'req-invalid-user',
      }),
      /userId is required\./,
    );

    await assert.rejects(
      repository.create({
        userId: 'user-1',
        apiId: 'api-weather',
        endpointId: 'endpoint-1',
        apiKeyId: 'key-1',
        developerId: 'dev-1',
        amount: -1n,
        requestId: 'req-negative-amount',
      }),
      /amount must be greater than or equal to 0\./,
    );

    await assert.rejects(
      repository.findByUserId(
        'user-1',
        new Date('2026-02-03T00:00:00.000Z'),
        new Date('2026-02-01T00:00:00.000Z'),
      ),
      /from must be before or equal to to\./,
    );

    await assert.rejects(
      repository.findByApiId('api-weather', undefined, undefined, -1),
      /limit must be a non-negative integer\./,
    );

    await assert.rejects(
      repository.findByUserId('user-1', new Date('nope')),
      /from must be a valid date\./,
    );

    await assert.rejects(
      repository.findByApiId('api-weather', undefined, new Date('nope')),
      /to must be a valid date\./,
    );

    await assert.rejects(
      repository.findUnindexedRevenueLedgerEvents('bad-cursor'),
      /cursor must be a non-negative integer string\./,
    );
  } finally {
    await pool.end();
  }
});

test('findByUserId without a limit returns every matching event in descending order', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-nolimit-1',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'user-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-2',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 200n,
      requestId: 'req-nolimit-2',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
    });

    const events = await repository.findByUserId('user-1');

    assert.deepEqual(
      events.map((event) => event.requestId),
      ['req-nolimit-2', 'req-nolimit-1'],
    );
  } finally {
    await pool.end();
  }
});

test('repository surfaces malformed amount values from the database', async () => {
  const malformedNumberRepository = new PgUsageEventsRepository({
    async query<T = unknown>() {
      return {
        rows: [
          {
            id: 1,
            user_id: 'user-1',
            api_id: 'api-weather',
            endpoint_id: 'endpoint-1',
            api_key_id: 'key-1',
            developer_id: 'dev-1',
            amount_usdc: 1.5,
            request_id: 'req-bad-number',
            stellar_tx_hash: null,
            created_at: new Date('2026-02-01T10:00:00.000Z'),
          },
        ] as T[],
      };
    },
  });

  const malformedStringRepository = new PgUsageEventsRepository({
    async query<T = unknown>() {
      return {
        rows: [
          {
            id: 1,
            user_id: 'user-1',
            api_id: 'api-weather',
            endpoint_id: 'endpoint-1',
            api_key_id: 'key-1',
            developer_id: 'dev-1',
            amount_usdc: '1.5',
            request_id: 'req-bad-string',
            stellar_tx_hash: null,
            created_at: '2026-02-01T10:00:00.000Z',
          },
        ] as T[],
      };
    },
  });

  await assert.rejects(
    malformedNumberRepository.findByUserId('user-1'),
    /amount_usdc must be an integer value\./,
  );

  await assert.rejects(
    malformedStringRepository.findByApiId('api-weather'),
    /amount_usdc must be stored as an integer string in smallest units\./,
  );
});

test('repository accepts bigint values returned directly from the database driver', async () => {
  const repository = new PgUsageEventsRepository({
    async query<T = unknown>() {
      return {
        rows: [
          {
            id: 7n,
            user_id: 'user-1',
            api_id: 'api-weather',
            endpoint_id: 'endpoint-1',
            api_key_id: 'key-1',
            developer_id: 'dev-1',
            amount_usdc: 450n,
            request_id: 'req-bigint-row',
            stellar_tx_hash: null,
            created_at: new Date('2026-02-01T10:00:00.000Z'),
          },
        ] as T[],
      };
    },
  });

  const events = await repository.findByUserId('user-1');

  assert.equal(events[0]?.id, '7');
  assert.equal(events[0]?.amount, 450n);
});

test('findUnindexedRevenueLedgerEvents resolves developer ownership from apis and skips indexed rows', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    // No apis table in Postgres anymore

    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-ledger-1',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'consumer-2',
      apiId: 'api-chat',
      endpointId: 'endpoint-2',
      apiKeyId: 'key-2',
      developerId: 'dev-1',
      amount: 250n,
      requestId: 'req-ledger-2',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
    });
    await repository.create({
      userId: 'consumer-3',
      apiId: 'api-missing',
      endpointId: 'endpoint-3',
      apiKeyId: 'key-3',
      developerId: 'dev-1',
      amount: 999n,
      requestId: 'req-ledger-3',
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
    });

    await pool.query(
      `
        INSERT INTO revenue_ledger (
          api_id,
          developer_id,
          amount_usdc,
          usage_event_id,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      ['api-weather', 'dev-weather', '100', '1', new Date('2026-02-01T10:00:00.000Z')],
    );

    const events = await repository.findUnindexedRevenueLedgerEvents();

    assert.deepEqual(events, [
      {
        usageEventId: '2',
        apiId: 'api-chat',
        amount: 250n,
        createdAt: new Date('2026-02-02T10:00:00.000Z'),
      },
      {
        usageEventId: '3',
        apiId: 'api-missing',
        amount: 999n,
        createdAt: new Date('2026-02-03T10:00:00.000Z'),
      },
    ]);
  } finally {
    await pool.end();
  }
});

test('indexRevenueLedgerEvent inserts idempotently by usageEventId', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-weather',
      endpointId: 'endpoint-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 1500n,
      requestId: 'req-ledger-insert',
      createdAt: new Date('2026-02-05T10:00:00.000Z'),
    });

    const insertedFirst = await repository.indexRevenueLedgerEvent({
      usageEventId: '1',
      apiId: 'api-weather',
      amount: 1500n,
      createdAt: new Date('2026-02-05T10:00:00.000Z'),
    }, 'dev-weather');
    const insertedDuplicate = await repository.indexRevenueLedgerEvent({
      usageEventId: '1',
      apiId: 'api-weather',
      amount: 1500n,
      createdAt: new Date('2026-02-05T10:00:00.000Z'),
    }, 'dev-weather');
    const count = await pool.query(
      'SELECT COUNT(*)::text AS count FROM revenue_ledger WHERE usage_event_id = $1',
      ['1'],
    );

    assert.equal(insertedFirst, true);
    assert.equal(insertedDuplicate, false);
    assert.equal(count.rows[0]?.count, '1');
  } finally {
    await pool.end();
  }
});

test('sumSpendByConsumer sums confirmed charges within [from, to) and excludes unconfirmed and other users', async () => {
  const { repository, pool } = createUsageEventsRepository();

  try {
    const from = new Date('2026-02-01T00:00:00.000Z');
    const to = new Date('2026-03-01T00:00:00.000Z');

    // Matching confirmed event 1
    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 100n,
      requestId: 'req-c-1',
      stellarTxHash: 'stellar-tx-1',
      createdAt: new Date('2026-02-10T12:00:00.000Z'),
    });

    // Matching confirmed event 2
    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-2',
      endpointId: 'ep-2',
      apiKeyId: 'key-2',
      developerId: 'dev-2',
      amount: 250n,
      requestId: 'req-c-2',
      stellarTxHash: 'stellar-tx-2',
      createdAt: new Date('2026-02-15T12:00:00.000Z'),
    });

    // Boundary check: created_at == from (INCLUDED)
    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 50n,
      requestId: 'req-c-from',
      stellarTxHash: 'stellar-tx-from',
      createdAt: from,
    });

    // Boundary check: created_at == to (EXCLUDED, since created_at < $3)
    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 9999n,
      requestId: 'req-c-to',
      stellarTxHash: 'stellar-tx-to',
      createdAt: to,
    });

    // Unconfirmed charge: stellarTxHash is null (EXCLUDED)
    await repository.create({
      userId: 'consumer-1',
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      amount: 500n,
      requestId: 'req-c-unconfirmed',
      stellarTxHash: null,
      createdAt: new Date('2026-02-12T12:00:00.000Z'),
    });

    // Other user event: caller was developer, not consumer (EXCLUDED)
    await repository.create({
      userId: 'other-user',
      apiId: 'api-1',
      endpointId: 'ep-1',
      apiKeyId: 'key-1',
      developerId: 'consumer-1',
      amount: 800n,
      requestId: 'req-c-other',
      stellarTxHash: 'stellar-tx-other',
      createdAt: new Date('2026-02-12T12:00:00.000Z'),
    });

    const result = await repository.sumSpendByConsumer({ userId: 'consumer-1', from, to });

    assert.equal(result.calls, 3);
    assert.equal(result.totalUnits, 400n); // 100n + 250n + 50n

    // Non-existent user returns 0 units and 0 calls
    const emptyResult = await repository.sumSpendByConsumer({ userId: 'nobody', from, to });
    assert.equal(emptyResult.calls, 0);
    assert.equal(emptyResult.totalUnits, 0n);
  } finally {
    await pool.end();
  }
});
