import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';

import { NotFoundError } from '../errors/index.js';
import { PgUserRepository, type UserRepositoryQueryable } from './userRepository.js';

function createUserRepository() {
  const db = newDb();

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => randomUUID(),
  });

  // Wrap the pool so every INSERT into users gets an explicit UUID,
  // working around pg-mem 3.x sharing gen_random_uuid across instances.
  const { Pool: PgPool } = db.adapters.createPg();
  const rawPool = new PgPool();

  const wrappedPool = {
    async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      const isUserInsert = /INSERT\s+INTO\s+users/i.test(text);
      if (isUserInsert && params && params.length === 1) {
        const id = randomUUID();
        const newText = text.replace(
          'INSERT INTO users (stellar_address)',
          'INSERT INTO users (id, stellar_address)'
        ).replace('VALUES ($1)', 'VALUES ($2, $1)');
        return rawPool.query(newText, [params[0], id]);
      }
      return rawPool.query(text, params);
    },
    end: () => rawPool.end(),
  };

  db.public.none(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      stellar_address TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return {
    repository: new PgUserRepository(wrappedPool as UserRepositoryQueryable),
    pool: wrappedPool,
  };
}

test('create stores a user and returns a camelCase DTO', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const user = await repository.create({ stellarAddress: 'GCREATE123456789' });

    assert.match(user.id, /^[0-9a-f-]{36}$/i);
    assert.equal(user.stellarAddress, 'GCREATE123456789');
    assert.ok(user.createdAt instanceof Date);
  } finally {
    await pool.end();
  }
});

test('findByStellarAddress returns the matching user', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const created = await repository.create({ stellarAddress: 'GFINDADDR123456' });

    const found = await repository.findByStellarAddress('GFINDADDR123456');

    assert.deepEqual(found, created);
  } finally {
    await pool.end();
  }
});

test('findByStellarAddress returns null when the user does not exist', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const found = await repository.findByStellarAddress('GMISSING123456789');

    assert.equal(found, null);
  } finally {
    await pool.end();
  }
});

test('findById returns the matching user', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const created = await repository.create({ stellarAddress: 'GFINDBYID123456' });

    const found = await repository.findById(created.id);

    assert.deepEqual(found, created);
  } finally {
    await pool.end();
  }
});

test('findById returns null for an unknown user id', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const found = await repository.findById('00000000-0000-4000-a000-999999999999');

    assert.equal(found, null);
  } finally {
    await pool.end();
  }
});

test('update changes the stellar address and preserves immutable fields', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const created = await repository.create({ stellarAddress: 'GOLDADDRESS12345' });

    const updated = await repository.update(created.id, {
      stellarAddress: 'GNEWADDRESS12345',
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.stellarAddress, 'GNEWADDRESS12345');
    assert.deepEqual(updated.createdAt, created.createdAt);

    const found = await repository.findByStellarAddress('GNEWADDRESS12345');
    assert.deepEqual(found, updated);
  } finally {
    await pool.end();
  }
});

test('update throws NotFoundError for an unknown user id', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await assert.rejects(
      repository.update('00000000-0000-4000-a000-999999999999', {
        stellarAddress: 'GNEWADDRESS12345',
      }),
      (err: unknown) => { assert.ok(err instanceof Error); assert.match(err.message, /was not found/); return true; }
    );
  } finally {
    await pool.end();
  }
});

test('update with an empty patch returns the existing user unchanged', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const created = await repository.create({ stellarAddress: 'GNOOPUPDATE12345' });

    const updated = await repository.update(created.id, {});

    assert.deepEqual(updated, created);
  } finally {
    await pool.end();
  }
});

test('list returns paginated users ordered by newest first with total count', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await repository.create({ stellarAddress: 'GLISTFIRST123456' });
    await repository.create({ stellarAddress: 'GLISTSECOND12345' });
    await repository.create({ stellarAddress: 'GLISTTHIRD123456' });

    await pool.query(
      `
        UPDATE users
        SET created_at = CASE stellar_address
          WHEN 'GLISTFIRST123456' THEN TIMESTAMP '2026-03-01 00:00:00'
          WHEN 'GLISTSECOND12345' THEN TIMESTAMP '2026-03-02 00:00:00'
          WHEN 'GLISTTHIRD123456' THEN TIMESTAMP '2026-03-03 00:00:00'
        END
      `,
    );

    const result = await repository.list({ limit: 2, offset: 1 });

    assert.equal(result.total, 3);
    assert.equal(result.users.length, 2);
    assert.deepEqual(
      result.users.map((user) => user.stellar_address),
      ['GLISTSECOND12345', 'GLISTFIRST123456'],
    );
  } finally {
    await pool.end();
  }
});

////

// ─── Uniqueness constraints ───────────────────────────────────────────────────

test('create throws on duplicate stellar_address (uniqueness constraint)', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await repository.create({ stellarAddress: 'GDUPE111111111111' });

    await assert.rejects(
      repository.create({ stellarAddress: 'GDUPE111111111111' }),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error');
        // pg-mem surfaces uniqueness violations – message contains "unique"
        assert.match(err.message.toLowerCase(), /unique|duplicate|already exists/);
        return true;
      },
    );
  } finally {
    await pool.end();
  }
});

test('create allows two users with different stellar addresses', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const a = await repository.create({ stellarAddress: 'GUNIQUE_A_123456' });
    const b = await repository.create({ stellarAddress: 'GUNIQUE_B_123456' });

    assert.notEqual(a.id, b.id);
    assert.notEqual(a.stellarAddress, b.stellarAddress);
  } finally {
    await pool.end();
  }
});

test('update throws on stellar_address collision with an existing user', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await repository.create({ stellarAddress: 'GCOLLIDE_A_12345' });
    const b = await repository.create({ stellarAddress: 'GCOLLIDE_B_12345' });

    await assert.rejects(
      repository.update(b.id, { stellarAddress: 'GCOLLIDE_A_12345' }),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error');
        assert.match(err.message.toLowerCase(), /unique|duplicate|already exists/);
        return true;
      },
    );

    // Original record must remain intact after failed update
    const stillB = await repository.findById(b.id);
    assert.equal(stillB?.stellarAddress, 'GCOLLIDE_B_12345');
  } finally {
    await pool.end();
  }
});

// ─── Input validation (assertNonEmpty) ───────────────────────────────────────

test('create throws when stellarAddress is an empty string', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await assert.rejects(
      repository.create({ stellarAddress: '' }),
      /stellarAddress is required/,
    );
  } finally {
    await pool.end();
  }
});

test('create throws when stellarAddress is only whitespace', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await assert.rejects(
      repository.create({ stellarAddress: '   ' }),
      /stellarAddress is required/,
    );
  } finally {
    await pool.end();
  }
});

test('create trims leading/trailing whitespace from stellarAddress', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const user = await repository.create({ stellarAddress: '  GTRIMMED123456  ' });
    assert.equal(user.stellarAddress, 'GTRIMMED123456');
  } finally {
    await pool.end();
  }
});

test('findByStellarAddress throws when address is empty', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await assert.rejects(
      repository.findByStellarAddress(''),
      /stellarAddress is required/,
    );
  } finally {
    await pool.end();
  }
});

test('findById throws when id is empty', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await assert.rejects(
      repository.findById(''),
      /id is required/,
    );
  } finally {
    await pool.end();
  }
});

test('update throws when id is empty', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await assert.rejects(
      repository.update('', { stellarAddress: 'GVALID1234567890' }),
      /id is required/,
    );
  } finally {
    await pool.end();
  }
});

test('update throws when new stellarAddress is empty string', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const user = await repository.create({ stellarAddress: 'GEMPTYUPDATE1234' });

    await assert.rejects(
      repository.update(user.id, { stellarAddress: '' }),
      /stellarAddress is required/,
    );
  } finally {
    await pool.end();
  }
});

// ─── DTO shape / data-integrity ──────────────────────────────────────────────

test('returned UserDto never exposes raw DB column names', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const user = await repository.create({ stellarAddress: 'GDTO_SHAPE_12345' });

    // camelCase fields present
    assert.ok('id' in user);
    assert.ok('stellarAddress' in user);
    assert.ok('createdAt' in user);

    // snake_case columns must NOT leak through
    assert.ok(!('stellar_address' in user), 'stellar_address must not be exposed');
    assert.ok(!('created_at' in user), 'created_at must not be exposed');
  } finally {
    await pool.end();
  }
});

test('createdAt is a proper Date object, not a raw string', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const user = await repository.create({ stellarAddress: 'GDATETYPE1234567' });
    assert.ok(user.createdAt instanceof Date, 'createdAt must be a Date instance');
    assert.ok(!isNaN(user.createdAt.getTime()), 'createdAt must be a valid Date');
  } finally {
    await pool.end();
  }
});

// ─── list edge cases ─────────────────────────────────────────────────────────

test('list returns empty array and zero total when no users exist', async () => {
  const { repository, pool } = createUserRepository();

  try {
    const result = await repository.list({ limit: 10, offset: 0 });
    assert.equal(result.total, 0);
    assert.equal(result.users.length, 0);
  } finally {
    await pool.end();
  }
});

test('list offset beyond total returns empty users array with correct total', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await repository.create({ stellarAddress: 'GOFFSET_TEST1234' });

    const result = await repository.list({ limit: 10, offset: 999 });
    assert.equal(result.total, 1);
    assert.equal(result.users.length, 0);
  } finally {
    await pool.end();
  }
});

test('list users contain snake_case fields for list consumers', async () => {
  const { repository, pool } = createUserRepository();

  try {
    await repository.create({ stellarAddress: 'GLISTSHAPE123456' });

    const result = await repository.list({ limit: 10, offset: 0 });
    const item = result.users[0]!;

    assert.ok('id' in item);
    assert.ok('stellar_address' in item);
    assert.ok('created_at' in item);
  } finally {
    await pool.end();
  }
});
