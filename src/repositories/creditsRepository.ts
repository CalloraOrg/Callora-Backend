import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/index.js';
import type { Credit, NewCredit } from '../db/schema.js';

export interface CreditsRepository {
  findByUserId(userId: string): Promise<Credit | undefined>;
  getOrCreateByUserId(userId: string): Promise<Credit>;
  updateBalance(userId: string, newBalance: string): Promise<Credit>;
  grant(userId: string, amountUsdc: string): Promise<Credit>;
}

export const defaultCreditsRepository: CreditsRepository = {
  findByUserId,
  getOrCreateByUserId,
  updateBalance,
  grant,
};

const USDC_SCALE = 10_000_000n;
const amountPattern = /^\d+(?:\.\d{1,7})?$/;

function toUsdcUnits(amount: string): bigint {
  if (!amountPattern.test(amount)) {
    throw new Error('amountUsdc must be a non-negative decimal with at most 7 decimal places');
  }

  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(7, '0'));
}

function fromUsdcUnits(units: bigint): string {
  const whole = units / USDC_SCALE;
  const fraction = (units % USDC_SCALE).toString().padStart(7, '0').replace(/0+$/, '');
  return fraction.length === 0 ? `${whole}.00` : `${whole}.${fraction.padEnd(2, '0')}`;
}

interface RawCredit {
  id: number;
  user_id: string;
  balance_usdc: string;
  created_at: number;
  updated_at: number;
}

function mapRawCredit(credit: RawCredit): Credit {
  return {
    ...credit,
    created_at: new Date(credit.created_at * 1_000),
    updated_at: new Date(credit.updated_at * 1_000),
  };
}

/**
 * Find credits record by user ID.
 *
 * Prefers the EXPLAIN-verified covering index `idx_credits_lookup_hot`
 * (migrations/credits_index.sql) via INDEXED BY so the hot /api/credits
 * filter on user_id is served as a covering index scan even when a UNIQUE
 * autoindex on user_id also exists. Falls back to the Drizzle path when the
 * index has not been applied yet.
 */
export async function findByUserId(userId: string): Promise<Credit | undefined> {
  try {
    const raw = sqlite
      .prepare(
        `SELECT id, user_id, balance_usdc, created_at, updated_at
         FROM credits INDEXED BY idx_credits_lookup_hot
         WHERE user_id = ?
         LIMIT 1`,
      )
      .get(userId) as RawCredit | undefined;

    return raw ? mapRawCredit(raw) : undefined;
  } catch {
    const rows = await db
      .select()
      .from(schema.credits)
      .where(eq(schema.credits.user_id, userId))
      .limit(1);
    return rows[0];
  }
}

/**
 * Get existing credits record or create a new one with zero balance
 */
export async function getOrCreateByUserId(userId: string): Promise<Credit> {
  const existing = await findByUserId(userId);
  if (existing) {
    return existing;
  }

  const [inserted] = await db
    .insert(schema.credits)
    .values({
      user_id: userId,
      balance_usdc: '0.00',
    } as NewCredit)
    .returning();

  if (!inserted) {
    throw new Error('Credits record insert failed');
  }
  return inserted;
}

/**
 * Update balance for a user
 */
export async function updateBalance(userId: string, newBalance: string): Promise<Credit> {
  const existing = await findByUserId(userId);
  const now = new Date();

  if (!existing) {
    throw new Error(`Credits record not found for user ${userId}`);
  }

  const [updated] = await db
    .update(schema.credits)
    .set({
      balance_usdc: newBalance,
      updated_at: now,
    })
    .where(eq(schema.credits.id, existing.id))
    .returning();

  if (!updated) {
    throw new Error('Credits balance update failed');
  }
  return updated;
}

/**
 * Add prepaid credits without passing through floating-point arithmetic.
 *
 * The read/modify/write sequence runs in one synchronous SQLite transaction,
 * preventing concurrent admin grants from overwriting each other.
 */
export async function grant(userId: string, amountUsdc: string): Promise<Credit> {
  const amountUnits = toUsdcUnits(amountUsdc);
  if (amountUnits <= 0n) {
    throw new Error('amountUsdc must be greater than zero');
  }

  const grantTransaction = sqlite.transaction((id: string, amount: bigint): Credit => {
    const existing = sqlite
      .prepare('SELECT id, user_id, balance_usdc, created_at, updated_at FROM credits WHERE user_id = ?')
      .get(id) as RawCredit | undefined;
    const now = Math.floor(Date.now() / 1_000);

    if (!existing) {
      const balanceUsdc = fromUsdcUnits(amount);
      const inserted = sqlite
        .prepare('INSERT INTO credits (user_id, balance_usdc, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id, user_id, balance_usdc, created_at, updated_at')
        .get(id, balanceUsdc, now, now) as RawCredit | undefined;
      if (!inserted) throw new Error('Credits record insert failed');
      return mapRawCredit(inserted);
    }

    const balanceUsdc = fromUsdcUnits(toUsdcUnits(existing.balance_usdc) + amount);
    const updated = sqlite
      .prepare('UPDATE credits SET balance_usdc = ?, updated_at = ? WHERE id = ? RETURNING id, user_id, balance_usdc, created_at, updated_at')
      .get(balanceUsdc, now, existing.id) as RawCredit | undefined;
    if (!updated) throw new Error('Credits balance update failed');
    return mapRawCredit(updated);
  });

  return grantTransaction(userId, amountUnits);
}
