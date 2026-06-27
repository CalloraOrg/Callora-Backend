import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import type { UsageEventsRepository, UsageEvent } from '../../repositories/usageEventsRepository.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../../errors/index.js';
import { logger } from '../../logger.js';

export interface UsageCsvRouterDeps {
  usageEventsRepository: Pick<UsageEventsRepository, 'findByUser'>;
}

/**
 * Number of rows fetched from the repository per page while streaming.
 * Bounds peak memory usage: at most this many events are held in memory at
 * once regardless of how large the full export is.
 */
const BATCH_SIZE = 500;

/** Ordered CSV columns. Kept in sync with {@link buildCsvRow}. */
const CSV_COLUMNS = ['id', 'apiId', 'endpoint', 'occurredAt', 'revenue'] as const;
const CSV_HEADER = CSV_COLUMNS.join(',') + '\n';

/**
 * Parses a query-string value as a Date.
 * - `undefined` (param absent) → returns `undefined` (caller applies a default).
 * - present but unparseable → returns `null` so the caller can return a 400.
 */
const parseDateParam = (value: unknown): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Escapes a single CSV field per RFC 4180 and neutralises CSV/formula
 * injection.
 *
 * - Wraps the value in double quotes when it contains a comma, quote, or
 *   newline, doubling any embedded quotes.
 * - Prefixes a single quote when the value begins with a character a
 *   spreadsheet would interpret as a formula (`= + - @`, tab, CR), so that
 *   opening the export in Excel/Sheets cannot execute attacker-controlled
 *   content that arrived via API/endpoint identifiers.
 */
export const escapeCsvField = (value: string): string => {
  let field = value;
  if (/^[=+\-@\t\r]/.test(field)) {
    field = `'${field}`;
  }
  if (/[",\n\r]/.test(field)) {
    field = `"${field.replace(/"/g, '""')}"`;
  }
  return field;
};

/**
 * Minimal writable surface needed for backpressure-aware streaming. Satisfied
 * by an Express {@link Response} and easily faked in tests.
 */
export interface BackpressureSink {
  write(chunk: string): boolean;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Writes a chunk, respecting backpressure: if the socket buffer is full
 * (`write` returns `false`), the returned promise resolves only once the
 * stream drains, so a slow client cannot force unbounded server-side
 * buffering. Rejects on stream `error`/`close` so callers unwind cleanly
 * instead of hanging forever.
 */
export const writeChunk = (sink: BackpressureSink, chunk: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (sink.write(chunk)) {
      resolve();
      return;
    }
    const cleanup = () => {
      sink.off('drain', onDrain);
      sink.off('error', onError);
      sink.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (...args: unknown[]) => {
      cleanup();
      reject(args[0] instanceof Error ? args[0] : new Error('Response stream error'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Response closed before stream completed'));
    };
    sink.once('drain', onDrain);
    sink.once('error', onError);
    sink.once('close', onClose);
  });

const buildCsvRow = (event: UsageEvent): string =>
  [
    escapeCsvField(event.id),
    escapeCsvField(event.apiId),
    escapeCsvField(event.endpoint),
    escapeCsvField(event.occurredAt.toISOString()),
    escapeCsvField(event.revenue.toString()),
  ].join(',') + '\n';

/**
 * Router exposing `GET /api/usage/csv` — a streaming CSV export of the
 * authenticated user's usage events, filterable by date range and API.
 *
 * The handler streams the response with chunked transfer encoding: rows are
 * fetched from the repository one page at a time (see {@link BATCH_SIZE}) and
 * written straight to the socket, so memory stays bounded for arbitrarily
 * large exports. Input is validated before any bytes are written, so malformed
 * requests still receive the standard JSON error envelope.
 */
export function createUsageCsvRouter(deps: UsageCsvRouterDeps): Router {
  const router = Router();
  const { usageEventsRepository } = deps;

  router.get('/', requireAuth, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    // ── Input validation (boundary) ──────────────────────────────────────────
    const from = parseDateParam(req.query.from);
    if (from === null) {
      next(new BadRequestError('Invalid "from" date'));
      return;
    }
    const to = parseDateParam(req.query.to);
    if (to === null) {
      next(new BadRequestError('Invalid "to" date'));
      return;
    }

    if (req.query.apiId !== undefined && typeof req.query.apiId !== 'string') {
      next(new BadRequestError('apiId must be a single string value'));
      return;
    }
    const apiId = typeof req.query.apiId === 'string' && req.query.apiId.length > 0
      ? req.query.apiId
      : undefined;

    // Default to the last 30 days, mirroring GET /api/usage.
    const now = new Date();
    const queryFrom = from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const queryTo = to ?? now;

    if (queryFrom > queryTo) {
      next(new BadRequestError('from must be before or equal to to'));
      return;
    }

    // ── Streaming export ─────────────────────────────────────────────────────
    let offset = 0;
    let rowCount = 0;
    let headersWritten = false;

    const write = (chunk: string): Promise<void> => writeChunk(res, chunk);

    try {
      for (;;) {
        const events = await usageEventsRepository.findByUser({
          userId: user.id,
          from: queryFrom,
          to: queryTo,
          apiId,
          limit: BATCH_SIZE,
          offset,
        });

        // Defer header emission until the first successful query so that a
        // failure on the very first page surfaces as a JSON 500 instead of a
        // truncated body with a 200 status.
        if (!headersWritten) {
          res.status(200);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="usage-export-${now.toISOString().slice(0, 10)}.csv"`,
          );
          res.setHeader('Cache-Control', 'no-store');
          await write(CSV_HEADER);
          headersWritten = true;
        }

        for (const event of events) {
          await write(buildCsvRow(event));
        }
        rowCount += events.length;

        if (events.length < BATCH_SIZE) {
          break;
        }
        offset += BATCH_SIZE;
      }

      res.end();
      logger.info('[usage.csv] export completed', {
        userId: user.id,
        apiId,
        from: queryFrom.toISOString(),
        to: queryTo.toISOString(),
        rowCount,
      });
    } catch (error) {
      // If nothing has been written yet we can still return a clean error
      // envelope; otherwise the status/headers are already committed, so we log
      // and abort the connection to signal a truncated download.
      if (!res.headersSent) {
        logger.error('[usage.csv] export failed before streaming', { userId: user.id, error });
        next(new InternalServerError());
        return;
      }
      logger.error('[usage.csv] export failed mid-stream', {
        userId: user.id,
        rowCount,
        error,
      });
      res.destroy();
    }
  });

  return router;
}

export default createUsageCsvRouter;
