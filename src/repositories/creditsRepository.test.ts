jest.mock('../db/index.js', () => {
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE,
      balance_usdc TEXT NOT NULL DEFAULT '0.00',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_credits_lookup_hot
      ON credits (user_id, balance_usdc, created_at, updated_at);
  `);

  return { sqlite, db: {}, schema: { credits: {} } };
});

import { sqlite } from '../db/index.js';
import { grant, updateBalance } from './creditsRepository.js';

describe('creditsRepository', () => {
  beforeEach(() => {
    sqlite.prepare('DELETE FROM credits').run();
  });

  it('creates a credits row when granting to a new user', async () => {
    const credit = await grant('new-user', '2.50');

    expect(credit.user_id).toBe('new-user');
    expect(credit.balance_usdc).toBe('2.50');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM credits WHERE user_id = ?').get('new-user'))
      .toEqual({ count: 1 });
  });

  it('adds a grant to an existing balance without losing seven-decimal precision', async () => {
    sqlite.prepare('INSERT INTO credits (user_id, balance_usdc) VALUES (?, ?)').run('existing-user', '1.25');

    const credit = await grant('existing-user', '0.0000001');

    expect(credit.balance_usdc).toBe('1.2500001');
  });

  it('applies 100 concurrent grants exactly', async () => {
    await Promise.all(
      Array.from({ length: 100 }, () => grant('concurrent-user', '0.0000001')),
    );

    const row = sqlite
      .prepare('SELECT balance_usdc FROM credits WHERE user_id = ?')
      .get('concurrent-user') as { balance_usdc: string };
    expect(row.balance_usdc).toBe('0.00001');
  });

  it.each(['0', '-0.0000001'])('rejects a non-positive grant amount: %s', async (amount) => {
    await expect(grant('invalid-user', amount)).rejects.toThrow(
      'amountUsdc must be greater than zero',
    );
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM credits WHERE user_id = ?').get('invalid-user'))
      .toEqual({ count: 0 });
  });

  it('throws when updating the balance of an unknown user', async () => {
    await expect(updateBalance('unknown-user', '1.00')).rejects.toThrow(
      'Credits record not found for user unknown-user',
    );
  });
});