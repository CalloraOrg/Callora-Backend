import assert from 'node:assert/strict';
import { DataType, newDb } from 'pg-mem';

import { NotFoundError } from '../errors/index.js';
import { PgUserRepository, type UserRepositoryQueryable } from './userRepository.js';

function createUserRepository() {
  const db = newDb();
  let counter = 0;

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => {
      counter += 1;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, '0')}`;
    },
  });

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
    repository: new PgUserRepository(pool as UserRepositoryQueryable),
    pool,
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
      NotFoundError,
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
