import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { etagMiddleware } from '../../middleware/etag.js';
import { UnauthorizedError } from '../../errors/index.js';
import { logger, getRequestId } from '../../logger.js';

/**
 * Supported forecast periods.
 */
export type ForecastPeriod = 'month' | 'next_30_days' | 'week' | 'day';

/**
 * Forecast calculation result payload.
 */
export interface BillingForecastResponse {
  userId: string;
  lookbackDays: number;
  lookbackStart: string;
  lookbackEnd: string;
  windowSpentUsdc: string;
  dailyRunRateUsdc: string;
  forecastPeriod: ForecastPeriod;
  forecastDays: number;
  forecastedAmountUsdc: string;
  totalCalls: number;
  currency: string;
  generatedAt: string;
}

/**
 * Validation schema for query parameters on GET /api/billing/forecast.
 */
const getBillingForecastQuerySchema = z.object({
  lookbackDays: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === '') return 30;
      const num = Number(val);
      if (Number.isNaN(num) || !Number.isInteger(num)) {
        throw new Error('lookbackDays must be an integer between 1 and 90');
      }
      return num;
    })
    .pipe(
      z
        .number()
        .int('lookbackDays must be an integer between 1 and 90')
        .min(1, 'lookbackDays must be an integer between 1 and 90')
        .max(90, 'lookbackDays must be an integer between 1 and 90')
    ),
  period: z
    .enum(['month', 'next_30_days', 'week', 'day'], {
      errorMap: () => ({ message: 'period must be one of: month, next_30_days, week, day' }),
    })
    .optional()
    .default('month'),
});

/**
 * Helper to determine number of days in target forecast period.
 */
function getPeriodDays(period: ForecastPeriod): number {
  switch (period) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'month':
    case 'next_30_days':
    default:
      return 30;
  }
}

export interface BillingForecastRouterDeps {
  pool?: Pool | { query: (sql: string | { text: string; values: unknown[] }, values?: unknown[]) => Promise<{ rows: unknown[] }> };
}

/**
 * Creates the router for /api/billing/forecast.
 */
export function createBillingForecastRouter(deps: BillingForecastRouterDeps = {}): Router {
  const router = Router();

  /**
   * GET /api/billing/forecast
   *
   * Forecasts the user's next-period bill based on their historical run rate over a specified lookback window.
   *
   * Query Params:
   *   - lookbackDays: Lookback window in days (1 - 90, default 30)
   *   - period: Target forecast period ('month', 'next_30_days', 'week', 'day', default 'month')
   *
   * @returns {BillingForecastResponse}
   */
  router.get(
    '/',
    requireAuth,
    validate({ query: getBillingForecastQuerySchema }),
    etagMiddleware,
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction
    ): Promise<void> => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError('Authentication required'));
          return;
        }

        const query = getBillingForecastQuerySchema.parse(req.query);
        const lookbackDays = query.lookbackDays;
        const period = query.period as ForecastPeriod;
        const forecastDays = getPeriodDays(period);

        const now = new Date();
        const lookbackStart = new Date(now.getTime() - lookbackDays * 86_400_000);

        // Resolve pool from deps or req.app.locals
        const pool = deps.pool ?? (req.app?.locals?.dbPool as Pool | undefined);

        let windowSpent = 0;
        let totalCalls = 0;

        if (pool) {
          try {
            // Try querying billing_requests table first
            const result = await pool.query({
              text: `
                SELECT COALESCE(SUM(amount_usdc::numeric), 0)::text AS total_spent, COUNT(*)::int AS total_calls
                FROM billing_requests
                WHERE developer_id = $1 AND created_at >= $2
              `,
              values: [user.id, lookbackStart],
            });

            if (result.rows && result.rows.length > 0) {
              const row = result.rows[0] as { total_spent: string; total_calls: number };
              windowSpent = parseFloat(row.total_spent || '0');
              totalCalls = Number(row.total_calls || 0);
            }
          } catch {
            // Fallback: try querying usage_events table if billing_requests fails or does not exist
            try {
              const result = await pool.query({
                text: `
                  SELECT COALESCE(SUM(amount_usdc::numeric), 0)::text AS total_spent, COUNT(*)::int AS total_calls
                  FROM usage_events
                  WHERE (user_id = $1 OR developer_id = $1) AND created_at >= $2
                `,
                values: [user.id, lookbackStart],
              });

              if (result.rows && result.rows.length > 0) {
                const row = result.rows[0] as { total_spent: string; total_calls: number };
                windowSpent = parseFloat(row.total_spent || '0');
                totalCalls = Number(row.total_calls || 0);
              }
            } catch {
              // If pool query fails, default to zero spend
              windowSpent = 0;
              totalCalls = 0;
            }
          }
        }

        const dailyRunRate = windowSpent / lookbackDays;
        const forecastedAmount = dailyRunRate * forecastDays;

        const requestId = getRequestId(req) ?? 'unknown';

        logger.info(
          `Billing forecast generated for user ${user.id}: lookbackDays=${lookbackDays}, period=${period}, dailyRunRate=${dailyRunRate.toFixed(4)} USDC, forecastedAmount=${forecastedAmount.toFixed(4)} USDC`,
          { correlationId: requestId, userId: user.id }
        );

        const responsePayload: BillingForecastResponse = {
          userId: user.id,
          lookbackDays,
          lookbackStart: lookbackStart.toISOString(),
          lookbackEnd: now.toISOString(),
          windowSpentUsdc: windowSpent.toFixed(4),
          dailyRunRateUsdc: dailyRunRate.toFixed(4),
          forecastPeriod: period,
          forecastDays,
          forecastedAmountUsdc: forecastedAmount.toFixed(4),
          totalCalls,
          currency: 'USDC',
          generatedAt: now.toISOString(),
        };

        res.status(200).json(responsePayload);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

export default createBillingForecastRouter();
