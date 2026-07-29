import { z } from 'zod';

/** Maximum number of forecast points that can be returned in a single page. */
export const FORECAST_MAX_LIMIT = 100;

/** Default page size when no `limit` query param is provided. */
export const FORECAST_DEFAULT_LIMIT = 20;

/**
 * Zod schema for GET /api/forecast query parameters.
 *
 * - `limit`  – page size, positive integer 1–100, default 20
 * - `cursor` – optional opaque pagination cursor from a previous response
 */
export const listForecastQuerySchema = z.object({
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val, ctx) => {
      if (val === undefined) return FORECAST_DEFAULT_LIMIT;
      if (typeof val === 'string' && val.trim() === '') return FORECAST_DEFAULT_LIMIT;
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'limit must be a positive integer',
        });
        return z.NEVER;
      }
      return Math.min(n, FORECAST_MAX_LIMIT);
    }),
  cursor: z.string().optional(),
});

/**
 * Zod schema for route parameters containing a forecast ID.
 */
export const forecastParamsSchema = z.object({
  id: z.string().trim().min(1, 'Forecast ID is required'),
});

/**
 * Zod schema for POST /api/forecast body.
 */
export const createForecastSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255, 'Name must be 255 characters or fewer'),
  description: z.string().trim().max(1000, 'Description must be 1000 characters or fewer'),
});

/**
 * Zod schema for PATCH /api/forecast/:id body.
 */
export const updateForecastSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(255, 'Name must be 255 characters or fewer').optional(),
    description: z.string().trim().max(1000, 'Description must be 1000 characters or fewer').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type ListForecastQueryInput = z.infer<typeof listForecastQuerySchema>;
export type ForecastParamsInput = z.infer<typeof forecastParamsSchema>;
export type CreateForecastInput = z.infer<typeof createForecastSchema>;
export type UpdateForecastInput = z.infer<typeof updateForecastSchema>;
