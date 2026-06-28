import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Credit, NewCredit } from '../db/schema.js';

export interface CreditsRepository {
  findByUserId(userId: string): Promise<Credit | undefined>;
  getOrCreateByUserId(userId: string): Promise<Credit>;
  updateBalance(userId: string, newBalance: string): Promise<Credit>;
}

export const defaultCreditsRepository: CreditsRepository = {
  findByUserId,
  getOrCreateByUserId,
  updateBalance,
};

/**
 * Find credits record by user ID
 */
export async function findByUserId(userId: string): Promise<Credit | undefined> {
  const rows = await db
    .select()
    .from(schema.credits)
    .where(eq(schema.credits.user_id, userId))
    .limit(1);
  return rows[0];
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
