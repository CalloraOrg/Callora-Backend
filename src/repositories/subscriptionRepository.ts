import { and, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db, schema } from '../db/index.js';
import type { Subscription } from '../db/schema.js';
import type { SubscriptionStatus } from '../db/schema.js';
import type { RetryPolicy } from '../webhooks/webhook.types.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  user_id: string;
  api_id: number;
  metering_limit?: number | null;
  /** Optional per-subscription webhook retry policy override. */
  retry_policy?: RetryPolicy | null;
}

export interface UpdateSubscriptionInput {
  status?: SubscriptionStatus;
  metering_limit?: number | null;
  /** Optional per-subscription webhook retry policy override. Pass null to clear. */
  retry_policy?: RetryPolicy | null;
}

export interface SubscriptionRepository {
  create(data: CreateSubscriptionInput): Promise<Subscription>;
  findById(id: string): Promise<Subscription | undefined>;
  findByUserId(user_id: string): Promise<Subscription[]>;
  findActiveByUserAndApi(user_id: string, api_id: number): Promise<Subscription | undefined>;
  update(id: string, data: UpdateSubscriptionInput): Promise<Subscription | undefined>;
  cancel(id: string): Promise<Subscription | undefined>;
}

// ---------------------------------------------------------------------------
// Helpers: serialise / deserialise the JSON retry_policy blob
// ---------------------------------------------------------------------------

/**
 * Serialise a RetryPolicy to JSON text for DB storage.
 * Returns null when the policy is null/undefined (sentinel = use platform default).
 */
function serialiseRetryPolicy(policy?: RetryPolicy | null): string | null {
  if (policy == null) return null;
  return JSON.stringify(policy);
}

/**
 * Deserialise the stored JSON text back into a RetryPolicy.
 * Returns null when the stored value is null/undefined.
 * Invalid JSON is treated as null and does not throw.
 */
export function deserialiseRetryPolicy(raw: string | null | undefined): RetryPolicy | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RetryPolicy;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default (SQLite / Drizzle) implementation
// ---------------------------------------------------------------------------

async function create(data: CreateSubscriptionInput): Promise<Subscription> {
  const id = randomUUID();
  const now = new Date();

  const [inserted] = await db
    .insert(schema.subscriptions)
    .values({
      id,
      user_id: data.user_id,
      api_id: data.api_id,
      status: 'active',
      metering_limit: data.metering_limit ?? null,
      retry_policy: serialiseRetryPolicy(data.retry_policy),
      created_at: now,
      updated_at: now,
    })
    .returning();

  if (!inserted) throw new Error('Subscription insert failed');
  return inserted;
}

async function findById(id: string): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.id, id))
    .limit(1);
  return rows[0];
}

async function findByUserId(user_id: string): Promise<Subscription[]> {
  return db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, user_id))
    .orderBy(schema.subscriptions.created_at);
}

async function findActiveByUserAndApi(
  user_id: string,
  api_id: number,
): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.user_id, user_id),
        eq(schema.subscriptions.api_id, api_id),
        ne(schema.subscriptions.status, 'cancelled'),
      ),
    )
    .limit(1);
  return rows[0];
}

async function update(
  id: string,
  data: UpdateSubscriptionInput,
): Promise<Subscription | undefined> {
  const now = new Date();

  const [updated] = await db
    .update(schema.subscriptions)
    .set({
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.metering_limit !== undefined ? { metering_limit: data.metering_limit } : {}),
      // retry_policy: undefined means "leave as-is"; null means "clear to default"
      ...(data.retry_policy !== undefined
        ? { retry_policy: serialiseRetryPolicy(data.retry_policy) }
        : {}),
      updated_at: now,
    })
    .where(eq(schema.subscriptions.id, id))
    .returning();

  return updated;
}

async function cancel(id: string): Promise<Subscription | undefined> {
  const now = new Date();

  const [updated] = await db
    .update(schema.subscriptions)
    .set({
      status: 'cancelled',
      cancelled_at: now,
      updated_at: now,
    })
    .where(eq(schema.subscriptions.id, id))
    .returning();

  return updated;
}

export const defaultSubscriptionRepository: SubscriptionRepository = {
  create,
  findById,
  findByUserId,
  findActiveByUserAndApi,
  update,
  cancel,
};
