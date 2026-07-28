/**
 * Zod validation schemas for /api/admin routes.
 *
 * All schemas are co-located here so that:
 *  - The shapes served at the HTTP boundary are easy to audit in one place.
 *  - Route handlers stay thin — they import a schema and call validate().
 *  - TypeScript inferred types (e.g. `UsageAnomaliesQuery`) are available
 *    throughout the route layer without duplicating interface definitions.
 *
 * Naming convention:
 *  - Query-parameter schemas end in `QuerySchema`
 *  - Request-body schemas end in `BodySchema`
 *  - Route-parameter schemas end in `ParamsSchema`
 *  - Inferred TS types drop the "Schema" suffix.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Accepts an ISO-8601 date-time string and coerces it to a Date.
 * Returns a specific error message when the string cannot be parsed so that
 * the 400 response is actionable rather than generic.
 */
const isoDateString = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), {
    message: 'must be a valid ISO-8601 date-time string',
  })
  .transform((v) => new Date(v));

/**
 * Non-empty, single-value string after trimming.
 * Used for optional filter params that should not be passed as arrays.
 */
const singleStringParam = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// GET /api/admin/users  (pagination)
// ---------------------------------------------------------------------------

/**
 * Parsed query params for GET /api/admin/users.
 * Both `limit` and `offset` are coerced from query strings by
 * parsePagination() already, so we only document the raw shape here.
 */
export const usersQuerySchema = z.object({
  /** Maximum number of records to return (positive integer). */
  limit: z
    .string()
    .optional()
    .refine((v) => v === undefined || (/^\d+$/.test(v) && Number(v) > 0), {
      message: 'limit must be a positive integer',
    }),
  /** Zero-based page offset (non-negative integer). */
  offset: z
    .string()
    .optional()
    .refine((v) => v === undefined || (/^\d+$/.test(v) && Number(v) >= 0), {
      message: 'offset must be a non-negative integer',
    }),
});

export type UsersQuery = z.infer<typeof usersQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/admin/usage/:developerId
// POST /api/admin/usage/:developerId/reset
// ---------------------------------------------------------------------------

/**
 * Route params for developer-specific usage endpoints.
 */
export const developerIdParamsSchema = z.object({
  /** Non-empty developer identifier. */
  developerId: z.string().min(1, 'developerId is required'),
});

export type DeveloperIdParams = z.infer<typeof developerIdParamsSchema>;

// ---------------------------------------------------------------------------
// GET /api/admin/usage/anomalies
// ---------------------------------------------------------------------------

/**
 * Query params for GET /api/admin/usage/anomalies.
 *
 * Defaults are intentionally left out of the schema so that downstream
 * route logic can apply them; this keeps the schema a pure boundary
 * validator rather than a default-value source.
 */
export const usageAnomaliesQuerySchema = z.object({
  /** ISO-8601 start of the reporting window (optional). */
  from: isoDateString.optional(),
  /** ISO-8601 end of the reporting window (optional). */
  to: isoDateString.optional(),
  /**
   * Z-score threshold that classifies a data point as anomalous.
   * Accepts a decimal string between 1 and 10.
   */
  threshold: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 10;
    }, { message: 'threshold must be a number between 1 and 10' })
    .transform((v) => (v !== undefined ? Number(v) : undefined)),
  /**
   * Maximum number of anomalies to return.
   * Must be an integer between 1 and 1000.
   */
  limit: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      const n = Number(v);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 1000;
    }, { message: 'limit must be an integer between 1 and 1000' })
    .transform((v) => (v !== undefined ? Number(v) : undefined)),
  /** Filter to a specific API (optional). */
  apiId: singleStringParam.optional(),
});

export type UsageAnomaliesQuery = z.infer<typeof usageAnomaliesQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/admin/usage/export
// ---------------------------------------------------------------------------

/**
 * Query params for GET /api/admin/usage/export.
 */
export const usageExportQuerySchema = z.object({
  /** ISO-8601 start of the export window (optional). */
  from: isoDateString.optional(),
  /** ISO-8601 end of the export window (optional). */
  to: isoDateString.optional(),
  /** Filter by developer (optional). */
  developerId: singleStringParam.optional(),
  /** Filter by API (optional). */
  apiId: singleStringParam.optional(),
  /** Output format: 'csv' (default) or 'json'. */
  format: z.enum(['csv', 'json']).optional().default('csv'),
});

export type UsageExportQuery = z.infer<typeof usageExportQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/admin/usage/by-endpoint
// ---------------------------------------------------------------------------

/**
 * Query params for GET /api/admin/usage/by-endpoint.
 */
export const usageByEndpointQuerySchema = z.object({
  /** ISO-8601 start of the reporting window (optional). */
  from: isoDateString.optional(),
  /** ISO-8601 end of the reporting window (optional). */
  to: isoDateString.optional(),
  /**
   * Maximum number of results.
   * Must be an integer between 1 and 1000.
   */
  limit: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      const n = Number(v);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 1000;
    }, { message: 'limit must be an integer between 1 and 1000' })
    .transform((v) => (v !== undefined ? Number(v) : undefined)),
  /** Filter by API (optional). */
  apiId: singleStringParam.optional(),
  /** Filter by developer (optional). */
  developerId: singleStringParam.optional(),
});

export type UsageByEndpointQuery = z.infer<typeof usageByEndpointQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/admin/usage/spike
// ---------------------------------------------------------------------------

/**
 * Query params for GET /api/admin/usage/spike.
 *
 * Identical in shape to {@link usageAnomaliesQuerySchema} — both endpoints
 * accept the same filtering parameters (window, threshold, limit, apiId).
 * The difference is in the detection algorithm: anomalies flags both positive
 * (spike) and negative (drop) z-score deviations, while spike only flags
 * positive z-score deviations and includes a `percentageChange` field.
 */
export const spikeQuerySchema = z.object({
  /** ISO-8601 start of the reporting window (optional). */
  from: isoDateString.optional(),
  /** ISO-8601 end of the reporting window (optional). */
  to: isoDateString.optional(),
  /**
   * Z-score threshold that classifies a data point as a spike.
   * Accepts a decimal string between 1 and 10.
   */
  threshold: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 10;
    }, { message: 'threshold must be a number between 1 and 10' })
    .transform((v) => (v !== undefined ? Number(v) : undefined)),
  /**
   * Maximum number of spikes to return.
   * Must be an integer between 1 and 1000.
   */
  limit: z
    .string()
    .optional()
    .refine((v) => {
      if (v === undefined) return true;
      const n = Number(v);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 1000;
    }, { message: 'limit must be an integer between 1 and 1000' })
    .transform((v) => (v !== undefined ? Number(v) : undefined)),
  /** Filter to a specific API (optional). */
  apiId: singleStringParam.optional(),
});

export type SpikeQuery = z.infer<typeof spikeQuerySchema>;

// ---------------------------------------------------------------------------
// POST /api/admin/db/explain
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/admin/db/explain.
 * Kept in sync with the inline schema in explain.ts so both can share the
 * same validation logic once the route is migrated.
 */
export const dbExplainBodySchema = z.object({
  /** SQL query to explain — must be a SELECT or WITH (CTE). */
  query: z.string().min(1, 'Query is required').max(50_000, 'Query too long'),
  /** Optional positional parameters to pass to the query. */
  params: z.array(z.unknown()).optional().default([]),
});

export type DbExplainBody = z.infer<typeof dbExplainBodySchema>;

// ---------------------------------------------------------------------------
// GET /api/admin/quota/requests
// ---------------------------------------------------------------------------

/**
 * Query params for GET /api/admin/quota/requests.
 */
export const quotaRequestsQuerySchema = z.object({
  /** Filter by request status (optional). */
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export type QuotaRequestsQuery = z.infer<typeof quotaRequestsQuerySchema>;

// ---------------------------------------------------------------------------
// POST /api/admin/quota/requests/:id/approve
// POST /api/admin/quota/requests/:id/reject
// ---------------------------------------------------------------------------

/**
 * Route params for quota request action endpoints.
 */
export const quotaRequestIdParamsSchema = z.object({
  /** Non-empty quota request identifier. */
  id: z.string().min(1, 'id is required'),
});

export type QuotaRequestIdParams = z.infer<typeof quotaRequestIdParamsSchema>;

/**
 * Optional request body for quota request approval/rejection.
 */
export const quotaRequestActionBodySchema = z.object({
  /** Optional admin notes to attach to the action. */
  admin_notes: z.string().max(2000, 'admin_notes must not exceed 2000 characters').optional(),
});

export type QuotaRequestActionBody = z.infer<typeof quotaRequestActionBodySchema>;

// ---------------------------------------------------------------------------
// POST /api/admin/maintenance/banner
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/admin/maintenance/banner.
 */
export const maintenanceBannerBodySchema = z.object({
  /** Banner message text — required, non-empty after trimming. */
  message: z.string().trim().min(1, 'message must be a non-empty string').max(1000, 'message must not exceed 1000 characters'),
  /** Whether the banner is currently active. */
  isActive: z.boolean({ message: 'isActive must be a boolean' }),
});

export type MaintenanceBannerBody = z.infer<typeof maintenanceBannerBodySchema>;
