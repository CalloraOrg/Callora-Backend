import assert from 'node:assert/strict';
import { PostgresSequenceStore } from './postgresSequenceStore.js';
import type { Queryable } from '../db.js';

describe('PostgresSequenceStore', () => {
  test('uses an atomic upsert that advances from the greater of durable and ledger state', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ allocated_sequence: '43' }] });
    const store = new PostgresSequenceStore({ query } as unknown as Queryable);

    const allocated = await store.allocate('GACCOUNT', 42n);

    assert.equal(allocated, 43n);
    assert.match(query.mock.calls[0]?.[0], /ON CONFLICT \(account_id\) DO UPDATE/);
    assert.match(query.mock.calls[0]?.[0], /GREATEST\(transaction_sequences\.next_sequence, \$2::numeric\) \+ 1/);
    assert.deepEqual(query.mock.calls[0]?.[1], ['GACCOUNT', '42']);
  });

  test('surfaces partial database failures as retryable allocation failures to callers', async () => {
    const store = new PostgresSequenceStore({
      query: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as Queryable);

    await expect(store.allocate('GACCOUNT', 42n)).rejects.toThrow('database unavailable');
  });

  test('fails explicitly when the database write commits no returned sequence', async () => {
    const store = new PostgresSequenceStore({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Queryable);

    await expect(store.allocate('GACCOUNT', 42n)).rejects.toThrow(
      'Sequence allocation did not return a reserved value'
    );
  });
});
