import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { etagMiddleware, generateETag } from '../../middleware/etag.js';
import { ServiceUnavailableError, UnauthorizedError } from '../../errors/index.js';
import { logger, getRequestId } from '../../logger.js';
import type { UsageEventsRepository } from '../../repositories/usageEventsRepository.js';
import {
  PgUsageEventsRepository,
  type UsageEventsRepositoryQueryable,
} from '../../repositories/usageEventsRepository.pg.js';

/**
 * Supported forecast periods.
 */
export type ForecastPeriod = 'month' | 'next_30_days' | 'week' | 'day' | 'quarter';

/**
 * Forecast calculation result payload with exact 7-decimal USDC amounts.
 */
export interface BillingForecastResponse {
  userId: string;
  lookbackDays: number;
  lookbackStart: string;
  lookbackEnd: string;
  /** Total spend in window formatted with 7 decimals */
  windowSpentUsdc: string;
  /** Daily run rate formatted with 7 decimals */
  dailyRunRateUsdc: string;
  forecastPeriod: ForecastPeriod;
  forecastDays: number;
  /** Forecasted bill amount formatted with 7 decimals */
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
    .enum(['month', 'next_30_days', 'week', 'day', 'quarter'], {
      error: 'period must be one of: month, next_30_days, week, day, quarter',
    })
    .optional()
    .default('month'),
});

/**
 * Helper to determine number of days in target forecast period.
 */
export function getPeriodDays(period: ForecastPeriod): number {
  switch (period) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'quarter':
      return 90;
    case 'month':
    case 'next_30_days':
    default:
      return 30;
  }
}

/**
 * Performs half-up rounding on integer division (numerator / denominator).
 * For non-negative integers: ties where (remainder * 2 >= denominator) round up away from zero.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('Denominator must be non-zero');
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) {
    return quotient + 1n;
  }
  return quotient;
}

/**
 * Formats an amount in integer units (1 unit = 10^-7 USDC) as an exact 7-decimal USDC string.
 */
export function formatUnitsToUsdc(units: bigint): string {
  const isNegative = units < 0n;
  const abs = isNegative ? -units : units;
  const str = abs.toString();
  let formatted: string;
  if (str.length <= 7) {
    formatted = `0.${str.padStart(7, '0')}`;
  } else {
    const intPart = str.slice(0, str.length - 7);
    const fracPart = str.slice(str.length - 7);
    formatted = `${intPart}.${fracPart}`;
  }
  return isNegative ? `-${formatted}` : formatted;
}

export interface BillingForecastConsumerSpendRepository {
  sumSpendByConsumer: (query: { userId: string; from: Date; to: Date }) => Promise<{ totalUnits: bigint; calls: number }>;
}

export interface BillingForecastRouterDeps {
  pool?: Pool | { query: (sql: string | { text: string; values: unknown[] }, values?: unknown[]) => Promise<{ rows: unknown[] }> };
  usageEventsRepository?: UsageEventsRepository | BillingForecastConsumerSpendRepository;
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
   *   - period: Target forecast period ('month', 'next_30_days', 'week', 'day', 'quarter', default 'month')
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

        // Resolve repository from deps, req.app.locals, or construct from pool
        const pool = deps.pool ?? (req.app?.locals?.dbPool as Pool | undefined);
        const repository =
          deps.usageEventsRepository ??
          (req.app?.locals?.usageEventsRepository as UsageEventsRepository | undefined) ??
          (pool ? new PgUsageEventsRepository(pool as UsageEventsRepositoryQueryable) : undefined);

        const requestId = getRequestId() ?? 'unknown';

        if (!repository) {
          logger.error('Usage events repository or db pool not configured for billing forecast', {
            correlationId: requestId,
            userId: user.id,
          });
          next(new ServiceUnavailableError('Historical usage data is currently unavailable', 'FORECAST_DATA_UNAVAILABLE'));
          return;
        }

        let spendData: { totalUnits: bigint; calls: number };
        try {
          spendData = await repository.sumSpendByConsumer({
            userId: user.id,
            from: lookbackStart,
            to: now,
          });
        } catch (error) {
          logger.error('Failed to retrieve billing forecast data from repository', {
            correlationId: requestId,
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          next(new ServiceUnavailableError('Historical usage data is currently unavailable', 'FORECAST_DATA_UNAVAILABLE'));
          return;
        }

        const lookbackDaysBigInt = BigInt(lookbackDays);
        const forecastDaysBigInt = BigInt(forecastDays);

        const dailyRunRateUnits = roundHalfUp(spendData.totalUnits, lookbackDaysBigInt);
        const forecastedAmountUnits = roundHalfUp(spendData.totalUnits * forecastDaysBigInt, lookbackDaysBigInt);

        const windowSpentUsdc = formatUnitsToUsdc(spendData.totalUnits);
        const dailyRunRateUsdc = formatUnitsToUsdc(dailyRunRateUnits);
        const forecastedAmountUsdc = formatUnitsToUsdc(forecastedAmountUnits);

        logger.info(
          `Billing forecast generated for user ${user.id}: lookbackDays=${lookbackDays}, period=${period}, dailyRunRate=${dailyRunRateUsdc} USDC, forecastedAmount=${forecastedAmountUsdc} USDC`,
          { correlationId: requestId, userId: user.id }
        );

        // Derive deterministic ETag from stable data fields so volatile generatedAt does not change the tag
        const etagPayload = JSON.stringify({
          userId: user.id,
          lookbackDays,
          forecastPeriod: period,
          forecastDays,
          windowSpentUsdc,
          dailyRunRateUsdc,
          forecastedAmountUsdc,
          totalCalls: spendData.calls,
          currency: 'USDC',
        });
        res.setHeader('ETag', generateETag(etagPayload));

        const responsePayload: BillingForecastResponse = {
          userId: user.id,
          lookbackDays,
          lookbackStart: lookbackStart.toISOString(),
          lookbackEnd: now.toISOString(),
          windowSpentUsdc,
          dailyRunRateUsdc,
          forecastPeriod: period,
          forecastDays,
          forecastedAmountUsdc,
          totalCalls: spendData.calls,
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
