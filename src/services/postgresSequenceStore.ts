import { writeQuery, type Queryable } from '../db.js';
import type { SequenceStore } from './sequenceManager.js';

interface SequenceRow {
  allocated_sequence: string;
}

export class PostgresSequenceStore implements SequenceStore {
  constructor(private readonly db: Queryable = { query: writeQuery }) {}

  async allocate(accountId: string, ledgerNextSequence: bigint): Promise<bigint> {
    const { rows } = await this.db.query<SequenceRow>(
      `
      INSERT INTO transaction_sequences (account_id, next_sequence)
      VALUES ($1, ($2::numeric + 1))
      ON CONFLICT (account_id) DO UPDATE
      SET
        next_sequence = GREATEST(transaction_sequences.next_sequence, $2::numeric) + 1,
        updated_at = NOW()
      RETURNING (next_sequence - 1)::text AS allocated_sequence
      `,
      [accountId, ledgerNextSequence.toString()]
    );

    const allocatedSequence = rows[0]?.allocated_sequence;
    if (!allocatedSequence) {
      throw new Error('Sequence allocation did not return a reserved value');
    }

    return BigInt(allocatedSequence);
  }
}
