import { Router, type Request, type Response, type NextFunction } from 'express';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { createForecastAccessLogMiddleware } from '../middleware/forecastAccessLog.js';
import { successEnvelope } from '../lib/envelope.js';
import { getRequestId } from '../logger.js';
import { logger } from '../logger.js';
import { defaultAuditService } from '../services/auditService.js';
import {
  BadRequestError,
  GatewayTimeoutError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/index.js';
import {
  listForecastQuerySchema,
  forecastParamsSchema,
  createForecastSchema,
  updateForecastSchema,
  FORECAST_MAX_LIMIT,
  FORECAST_DEFAULT_LIMIT,
  type CreateForecastInput,
  type UpdateForecastInput,
} from '../validators/forecast.js';

export { FORECAST_MAX_LIMIT, FORECAST_DEFAULT_LIMIT };

export interface ForecastPoint {
  timestamp: string;
  value: number;
}

/**
 * @deprecated Use PaginatedForecastResponse instead.
 * Kept for backward-compat with internal uses of the old single-shot response shape.
 */
export interface ForecastResponse {
  forecast: ForecastPoint[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Pagination types for GET /api/forecast
// ---------------------------------------------------------------------------

/**
 * Paginated envelope returned by GET /api/forecast.
 *
 * - `items`       – the current page of ForecastPoint objects.
 * - `next_cursor` – opaque base-64 cursor; present only when a subsequent
 *                   page exists.  Absent (not `null`) when this is the last page.
 * - `total`       – total number of points in the underlying data set.
 *                   Allows clients to show "page X of Y" UI without a second
 *                   round-trip.
 */
export interface PaginatedForecastResponse {
  items: ForecastPoint[];
  next_cursor?: string;
  total: number;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Encode an integer index into an opaque base-64 cursor.
 * Format (before encoding): `fc:<index>`
 */
function encodeCursor(index: number): string {
  return Buffer.from(`fc:${index}`, 'utf-8').toString('base64url');
}

/**
 * Decode a cursor back to a numeric index.
 * Returns `null` when the cursor is missing or malformed so callers can
 * surface a structured 400 error.
 */
function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    const match = /^fc:(\d+)$/.exec(decoded);
    if (!match) return null;
    const idx = parseInt(match[1], 10);
    return Number.isFinite(idx) && idx >= 0 ? idx : null;
  } catch {
    return null;
  }
}

export interface Forecast {
  id: string;
  name: string;
  description: string;
  points: ForecastPoint[];
  createdAt: string;
  updatedAt: string;
}

// In-memory store for forecast data (simulated persistence)
const forecastStore = new Map<string, Forecast>();

// -----------------------------------------------------------------------
// Helper functions
// -----------------------------------------------------------------------

/**
 * Generate a new forecast ID (simulated).
 */
function generateForecastId(): string {
  return 'forecast_' + Math.random().toString(36).substr(2, 9);
}

function simulateForecastCalculation(signal?: AbortSignal): ForecastPoint[] {
  const now = Date.now();
  const points: ForecastPoint[] = [];

  for (let i = 0; i < 24; i++) {
    if (signal?.aborted) {
      throw new GatewayTimeoutError('Forecast calculation timed out');
    }

    const timestamp = new Date(now + i * 3_600_000).toISOString();
    const value = Math.round(Math.random() * 100 * 100) / 100;
    points.push({ timestamp, value });
  }

  return points;
}

/**
 * Helper to safely extract auditContext from request.
 * Defensive against missing middleware attachment.
 */
function getAuditContext(req: Request) {
  const auditContext = (req as Request & { auditContext?: Record<string, unknown> }).auditContext;
  return auditContext || {
    clientIp: 'unknown',
    userAgent: undefined,
    tenantId: null,
    correlationId: undefined,
    bodyHash: null,
  };
}

/**
 * Create a new forecast entry and record audit event.
 * 
 * Audit capture ordering:
 *   1. Validate input
 *   2. Create new forecast (before state = null for creation)
 *   3. Record audit event with before=null, after=created forecast
 */
async function createForecast(
  input: CreateForecastInput,
  actor: string,
  req: Request,
): Promise<Forecast> {
  const id = generateForecastId();
  const now = new Date().toISOString();

  // Create the forecast (after-state)
  const forecast: Forecast = {
    id,
    name: input.name,
    description: input.description,
    points: simulateForecastCalculation(req.signal),
    createdAt: now,
    updatedAt: now,
  };

  // Store it
  forecastStore.set(id, forecast);

  // Audit the creation: before=null (new entry), after=the created forecast
  const auditContext = getAuditContext(req);
  await defaultAuditService.record({
    event: 'forecast.create',
    actor,
    tenantId: auditContext.tenantId,
    clientIp: auditContext.clientIp as string | undefined,
    userAgent: auditContext.userAgent as string | undefined,
    correlationId: auditContext.correlationId as string | undefined,
    bodyHash: auditContext.bodyHash as string | null | undefined,
    details: {
      before: null, // Creation: no previous state
      after: forecast,
      forecastId: id,
    },
  });

  return forecast;
}

/**
 * Update an existing forecast and record audit event.
 * 
 * Audit capture ordering (CRITICAL - capture before-state FIRST):
 *   1. Fetch current forecast (before-state, BEFORE mutation applied)
 *   2. Apply mutation to in-memory copy
 *   3. Store mutated version
 *   4. Audit: before=fetched state, after=updated state
 *   
 * This ensures before/after are genuinely different states, not both pointing
 * to the same mutated object reference.
 */
async function updateForecast(
  id: string,
  input: UpdateForecastInput,
  actor: string,
  req: Request,
): Promise<Forecast> {
  // Step 1: Fetch before-state FIRST, before applying any mutations
  const beforeForecast = forecastStore.get(id);
  if (!beforeForecast) {
    throw new NotFoundError(`Forecast ${id} not found`);
  }

  // Step 2: Create a shallow copy and apply mutations to the new object
  const afterForecast: Forecast = {
    ...beforeForecast,
    name: input.name ?? beforeForecast.name,
    description: input.description ?? beforeForecast.description,
    updatedAt: new Date().toISOString(),
  };

  // Step 3: Store the updated version
  forecastStore.set(id, afterForecast);

  // Step 4: Record audit event with captured before/after states
  const auditContext = getAuditContext(req);
  await defaultAuditService.record({
    event: 'forecast.update',
    actor,
    tenantId: auditContext.tenantId,
    clientIp: auditContext.clientIp as string | undefined,
    userAgent: auditContext.userAgent as string | undefined,
    correlationId: auditContext.correlationId as string | undefined,
    bodyHash: auditContext.bodyHash as string | null | undefined,
    details: {
      before: beforeForecast, // Captured BEFORE mutation
      after: afterForecast,   // The result after update
      forecastId: id,
      updatedFields: Object.keys(input).filter((k) => input[k as keyof UpdateForecastInput] !== undefined),
    },
  });

  return afterForecast;
}

/**
 * Delete a forecast and record audit event.
 * 
 * Audit capture ordering:
 *   1. Fetch current state (before-state)
 *   2. Delete entry
 *   3. Audit: before=deleted forecast, after=null
 */
async function deleteForecast(
  id: string,
  actor: string,
  req: Request,
): Promise<void> {
  // Step 1: Fetch before-state before deletion
  const beforeForecast = forecastStore.get(id);
  if (!beforeForecast) {
    throw new NotFoundError(`Forecast ${id} not found`);
  }

  // Step 2: Delete the forecast
  forecastStore.delete(id);

  // Step 3: Audit the deletion: before=deleted forecast, after=null
  const auditContext = getAuditContext(req);
  await defaultAuditService.record({
    event: 'forecast.delete',
    actor,
    tenantId: auditContext.tenantId,
    clientIp: auditContext.clientIp as string | undefined,
    userAgent: auditContext.userAgent as string | undefined,
    correlationId: auditContext.correlationId as string | undefined,
    bodyHash: auditContext.bodyHash as string | null | undefined,
    details: {
      before: beforeForecast, // The deleted forecast
      after: null,             // Deletion: no subsequent state
      forecastId: id,
    },
  });
}

// -----------------------------------------------------------------------
// Route helpers
// -----------------------------------------------------------------------

/**
 * Express async handler wrapper to avoid try-catch boilerplate and ensure
 * errors propagate to the error handler middleware.
 */
function asyncHandler(
  fn: (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// -----------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------

export function createForecastRouter(timeoutMs = 5_000): Router {
  const router = Router();

  router.use(createTimeoutMiddleware({ durationMs: timeoutMs }));

  // Structured access log for every /api/forecast request.
  // Emits: req-id, latency, status, response size, and actor on the `forecast` channel.
  router.use(createForecastAccessLogMiddleware());

  // -----------------------------------------------------------------------
  // GET /api/forecast
  // List forecast points with cursor-based pagination.
  //
  // Query params:
  //   limit  – integer 1-100, default 20
  //   cursor – opaque cursor returned by a previous response (base64url)
  //
  // Response shape (inside successEnvelope.data):
  //   {
  //     items:       ForecastPoint[],   // current page of points
  //     next_cursor: string | undefined, // present only when more pages exist
  //     total:       number,             // total points in the data set
  //   }
  //
  // Not audited (read-only).
  // -----------------------------------------------------------------------
  router.get(
    '/',
    validate({ query: listForecastQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const requestId = getRequestId(req) ?? 'unknown';

        const { limit, cursor: rawCursor } = listForecastQuerySchema.parse(req.query);

        // ---- Resolve start index from cursor -----------------------------------
        let startIndex = 0;
        if (rawCursor !== undefined && rawCursor.trim() !== '') {
          const decoded = decodeCursor(rawCursor.trim());
          if (decoded === null) {
            // Malformed or tampered cursor – return 400.
            throw new BadRequestError(
              'Invalid or malformed cursor. Obtain a fresh cursor from the next_cursor field of a previous response.',
            );
          }
          startIndex = decoded;
        }

        // ---- Generate the full forecast data set (deterministic per request) --
        const allPoints = simulateForecastCalculation(req.signal ?? req.abortSignal);
        const total = allPoints.length;

        // ---- Slice the requested page ------------------------------------------
        const pagePoints = allPoints.slice(startIndex, startIndex + limit);
        const nextIndex = startIndex + limit;
        const hasMore = nextIndex < total;

        // ---- Build paginated response envelope --------------------------------
        const data: PaginatedForecastResponse = {
          items: pagePoints,
          total,
          ...(hasMore ? { next_cursor: encodeCursor(nextIndex) } : {}),
        };

        // ---- Structured logging with correlation ID ---------------------------
        logger.info('forecast.list', {
          requestId,
          limit,
          startIndex,
          returnedCount: pagePoints.length,
          total,
          hasMore,
        });

        res.json(successEnvelope(data, requestId));
      } catch (err) {
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/forecast
  // Create a new named forecast. Requires authentication.
  // State-changing: AUDITED.
  // -----------------------------------------------------------------------
  router.post(
    '/',
    requireAuth,
    validate({ body: createForecastSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const input = createForecastSchema.parse(req.body);
      const forecast = await createForecast(input, user.id, req);

      logger.audit('forecast.create', user.id, {
        forecastId: forecast.id,
        name: forecast.name,
      });

      const requestId = getRequestId(req) ?? 'unknown';
      res.status(201).json(successEnvelope(forecast, requestId));
    }),
  );

  // -----------------------------------------------------------------------
  // GET /api/forecast/:id
  // Retrieve a named forecast by ID. Not audited (read-only).
  // -----------------------------------------------------------------------
  router.get(
    '/:id',
    validate({ params: forecastParamsSchema }),
    asyncHandler(async (req, res) => {
      const { id } = forecastParamsSchema.parse(req.params);
      const forecast = forecastStore.get(id);
      if (!forecast) {
        throw new NotFoundError(`Forecast ${id} not found`);
      }

      const requestId = getRequestId(req) ?? 'unknown';
      res.json(successEnvelope(forecast, requestId));
    }),
  );

  // -----------------------------------------------------------------------
  // PATCH /api/forecast/:id
  // Update an existing forecast. Requires authentication.
  // State-changing: AUDITED.
  // -----------------------------------------------------------------------
  router.patch(
    '/:id',
    requireAuth,
    validate({ params: forecastParamsSchema, body: updateForecastSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const { id } = forecastParamsSchema.parse(req.params);
      const input = updateForecastSchema.parse(req.body);
      const updated = await updateForecast(id, input, user.id, req);

      logger.audit('forecast.update', user.id, {
        forecastId: updated.id,
        updates: Object.keys(input).filter((k) => input[k as keyof UpdateForecastInput] !== undefined),
      });

      const requestId = getRequestId(req) ?? 'unknown';
      res.json(successEnvelope(updated, requestId));
    }),
  );

  // -----------------------------------------------------------------------
  // DELETE /api/forecast/:id
  // Delete an existing forecast. Requires authentication.
  // State-changing: AUDITED.
  // -----------------------------------------------------------------------
  router.delete(
    '/:id',
    requireAuth,
    validate({ params: forecastParamsSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const { id } = forecastParamsSchema.parse(req.params);
      await deleteForecast(id, user.id, req);

      logger.audit('forecast.delete', user.id, {
        forecastId: id,
      });

      const requestId = getRequestId(req) ?? 'unknown';
      res.status(204).json(successEnvelope({ success: true }, requestId));
    }),
  );

  return router;
}

export default createForecastRouter;
