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
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
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

// Type exports for use in application code
export type Api = typeof apis.$inferSelect;
export type NewApi = typeof apis.$inferInsert;
export type ApiEndpoint = typeof apiEndpoints.$inferSelect;
export type NewApiEndpoint = typeof apiEndpoints.$inferInsert;