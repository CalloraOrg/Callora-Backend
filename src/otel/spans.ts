/**
 * OpenTelemetry tracing spans helpers.
 *
 * Provides lightweight wrappers to instrument route handlers with
 * per-endpoint tracing spans.  Integrates with the project's existing
 * request-id infrastructure for correlation between logs, traces, and
 * response bodies.
 *
 * Usage in a route handler:
 *   import { withSpan } from '../../otel/spans.js';
 *
 *   router.post('/', requireAuth, async (req, res, next) => {
 *     await withSpan('POST /api/quota/requests', req, async () => {
 *       // ... handler logic ...
 *     });
 *   });
 *
 * Spans are marked as INTERNAL (server-side processing).  The active
 * request-id from `req.id` is set as the `requestId` attribute on every
 * span so backends (Jaeger, Tempo, etc.) can correlate traces with log
 * entries and API responses.
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import type { Request } from 'express';

// ---------------------------------------------------------------------------
// Tracer singleton — scoped to this service so spans are grouped in the UI
// ---------------------------------------------------------------------------

const TRACER_NAME = 'callora-quota-service';

let _tracer: Tracer | undefined;

function getTracer(): Tracer {
  if (!_tracer) {
    _tracer = trace.getTracer(TRACER_NAME);
  }
  return _tracer;
}

/**
 * Allow tests to inject a mock / noop tracer instance.
 * @internal
 */
export function __setTracer(t: Tracer): void {
  _tracer = t;
}

// ---------------------------------------------------------------------------
// Span options
// ---------------------------------------------------------------------------

export interface SpanOptions {
  /** Human-readable operation name (e.g. "POST /api/quota/requests"). */
  name: string;
  /** Express request – used to read req.id for correlation. */
  req: Request;
  /** Additional key-value attributes to attach to the span. */
  attributes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// withSpan – the primary public helper
// ---------------------------------------------------------------------------

/**
 * Execute `fn` inside an active OpenTelemetry span.
 *
 * - Creates a new INTERNAL span named `options.name`.
 * - Sets `requestId` and any custom `attributes` on the span.
 * - Records exceptions and marks the span as ERROR on failure.
 * - Ends the span automatically in a `finally` block.
 *
 * @returns The return value of `fn`.
 * @throws Re-throws any error thrown by `fn` after recording it.
 */
export async function withSpan<T>(
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(options.name, { kind: SpanKind.INTERNAL });

  // Attach correlation id so span backends can join with logs.
  if (options.req.id) {
    span.setAttribute('requestId', options.req.id);
  }

  // Attach any caller-supplied attributes.
  if (options.attributes) {
    for (const [key, value] of Object.entries(options.attributes)) {
      span.setAttribute(key, value);
    }
  }

  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}
