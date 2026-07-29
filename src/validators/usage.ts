/**
 * Zod validation schemas for /api/usage routes.
 *
 * Schemas are co-located here so that:
 *  - The shapes served at the HTTP boundary are easy to audit in one place.
 *  - Route handlers stay thin — they import a schema and call safeParse().
 *  - TypeScript inferred types are available without duplicating interfaces.
 *
 * Naming convention:
 *  - Query-parameter schemas end in `QuerySchema`
 *  - Inferred TS types drop the "Schema" suffix.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// GET /api/usage  (query parameters)
// ---------------------------------------------------------------------------

/**
 * Validated query parameters for listing usage events.
 *
 * Supports both offset/limit and cursor-based pagination.
 * Date range defaults to the last 30 days when neither from/to is provided.
 */
export const UsageQuerySchema = z
  .object({
    /** ISO-8601 start of the query window (optional, defaults to 30 days ago). */
    from: z.string().datetime().optional(),
    /** ISO-8601 end of the query window (optional, defaults to now). */
    to: z.string().datetime().optional(),
    /** Filter events to a specific API (optional). */
    apiId: z.string().optional(),
    /** Aggregation period for stats (optional). */
    groupBy: z.enum(["day", "week", "month"]).optional(),
    /** Maximum number of events to return (1–100, default 20). */
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Legacy cursor token for cursor-based pagination (base64-encoded). */
    cursor: z.string().optional(),
    /** Forward cursor for stable cursor-based pagination (base64-encoded). */
    after: z.string().optional(),
    /** Backward cursor for stable cursor-based pagination (base64-encoded). */
    before: z.string().optional(),
    /** Zero-based offset for offset/limit pagination (optional). */
    offset: z.coerce.number().int().min(0).optional(),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return new Date(data.from) <= new Date(data.to);
      }
      return true;
    },
    {
      message: "'from' date must be before or equal to 'to' date",
      path: ["from"],
    },
  );

/** Inferred type for a validated usage query. */
export type UsageQueryInput = z.infer<typeof UsageQuerySchema>;
