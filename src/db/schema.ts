import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Developers table (one profile per user; user_id from auth e.g. x-user-id)
export const developers = sqliteTable('developers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id').notNull().unique(),
  name: text('name'),
  website: text('website'),
  description: text('description'),
  category: text('category'),
  plan_overrides: text('plan_overrides'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export type Developer = typeof developers.$inferSelect;
export type NewDeveloper = typeof developers.$inferInsert;

// Status enum for APIs
export const apiStatusEnum = ['draft', 'active', 'paused', 'archived'] as const;
export type ApiStatus = typeof apiStatusEnum[number];

// HTTP methods enum for API endpoints  
export const httpMethodEnum = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = typeof httpMethodEnum[number];

// APIs table
export const apis = sqliteTable('apis', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  developer_id: integer('developer_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  base_url: text('base_url').notNull(),
  logo_url: text('logo_url'),
  category: text('category'),
  status: text('status', { enum: apiStatusEnum }).notNull().default('draft'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  /** Soft-delete tombstone. NULL = live; non-NULL = deleted at that timestamp. */
  deleted_at: integer('deleted_at', { mode: 'timestamp' }),
});

// API endpoints table  
export const apiEndpoints = sqliteTable('api_endpoints', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  api_id: integer('api_id')
    .notNull()
    .references(() => apis.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  method: text('method', { enum: httpMethodEnum }).notNull().default('GET'),
  price_per_call_usdc: text('price_per_call_usdc').notNull().default('0.01'), // Using text for precise decimal handling
  description: text('description'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
});

// Schema versions table (single source of truth for applied migrations with checksums)
export const schemaVersions = sqliteTable('schema_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: integer('version').notNull().unique(),
  filename: text('filename').notNull(),
  checksum: text('checksum').notNull(),
  applied_at: text('applied_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  executed_by: text('executed_by'),
});

export type SchemaVersion = typeof schemaVersions.$inferSelect;
export type NewSchemaVersion = typeof schemaVersions.$inferInsert;


// Credits table for prepaid balance tracking per developer
export const credits = sqliteTable('credits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id').notNull().unique(),
  balance_usdc: text('balance_usdc').notNull().default('0.00'), // Using text for precise decimal handling
  created_at: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export type Credit = typeof credits.$inferSelect;
export type NewCredit = typeof credits.$inferInsert;

// Plans table — subscription plan offerings with pricing and request limits
export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceUsdc: text('price_usdc').notNull().default('0'),
  requestsPerMonth: integer('requests_per_month').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;

// Type exports for use in application code
export type Api = typeof apis.$inferSelect;
export type NewApi = typeof apis.$inferInsert;
export type ApiEndpoint = typeof apiEndpoints.$inferSelect;
export type NewApiEndpoint = typeof apiEndpoints.$inferInsert;

// Quota requests table — stores developer-initiated tier/override requests
// and their admin resolution. requested_overrides is JSON-serialised text.
export const quotaRequests = sqliteTable('quota_requests', {
  id: text('id').primaryKey(),                    // UUID generated in service
  developer_id: text('developer_id').notNull(),   // references developers.user_id
  requested_tier: text('requested_tier').notNull(),
  reason: text('reason').notNull(),
  requested_overrides: text('requested_overrides'), // JSON: { monthlyCallLimit?, rateLimitMaxRequests? }
  status: text('status', { enum: ['pending', 'approved', 'rejected'] })
    .notNull()
    .default('pending'),
  admin_notes: text('admin_notes'),
  resolved_by: text('resolved_by'),
  resolved_at: integer('resolved_at', { mode: 'timestamp' }),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export type QuotaRequestRow = typeof quotaRequests.$inferSelect;
export type NewQuotaRequestRow = typeof quotaRequests.$inferInsert;

// ---------------------------------------------------------------------------
// Subscriptions — per-user subscriptions to marketplace APIs
// ---------------------------------------------------------------------------

export const subscriptionStatusEnum = ['active', 'paused', 'cancelled'] as const;
export type SubscriptionStatus = (typeof subscriptionStatusEnum)[number];

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  api_id: integer('api_id')
    .notNull()
    .references(() => apis.id, { onDelete: 'cascade' }),
  status: text('status', { enum: subscriptionStatusEnum }).notNull().default('active'),
  /** Maximum calls per calendar month. NULL means unlimited. */
  metering_limit: integer('metering_limit'),
  /**
   * Per-subscription webhook retry policy override.
   * Stored as a JSON string: { maxRetries?: number, baseDelayMs?: number }.
   * NULL means use the platform default (maxRetries: 5, baseDelayMs: 1000 ms).
   */
  retry_policy: text('retry_policy'),
  created_at: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  cancelled_at: integer('cancelled_at', { mode: 'timestamp' }),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
