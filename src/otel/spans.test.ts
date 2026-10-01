/**
 * Unit tests for the `withSpan` OpenTelemetry helper in `src/otel/spans.ts`.
 *
 * `withSpan` is a thin wrapper around the OpenTelemetry tracing API.  Its
 * contract is small but easy to break silently:
 *
 *   - a span is created with the requested name and INTERNAL kind
 *   - `req.id` is attached as the `requestId` attribute (plus custom attrs)
 *   - success marks the span OK
 *   - a thrown error is recorded (`recordException`) and marks the span ERROR
 *   - the span is always ended exactly once, even when the callback rejects
 *
 * These tests inject a deterministic in-memory tracer via the exported
 * `__setTracer` seam so span attributes, status, exceptions and lifecycle can
 * be asserted without registering a real OpenTelemetry SDK.
 */

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, Tracer, SpanOptions as OtelSpanOptions } from '@opentelemetry/api';
import type { Request } from 'express';
import { withSpan, __setTracer } from './spans.js';

const TRACER_NAME = 'callora-quota-service';

// ---------------------------------------------------------------------------
// In-memory tracer
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  exceptions: unknown[];
  endCalls: number;
  ended: boolean;
}

function createInMemoryTracer(): {
  tracer: Tracer;
  getSpans: () => RecordedSpan[];
  getStartSpanCalls: () => number;
} {
  const spans: RecordedSpan[] = [];
  let startSpanCalls = 0;

  const tracer = {
    startSpan(name: string, options?: OtelSpanOptions): Span {
      startSpanCalls += 1;

      const recorded: RecordedSpan = {
        name,
        kind: options?.kind ?? SpanKind.INTERNAL,
        attributes: {},
        status: { code: SpanStatusCode.UNSET },
        exceptions: [],
        endCalls: 0,
        ended: false,
      };
      spans.push(recorded);

      const mockSpan = {
        setAttribute(key: string, value: string) {
          recorded.attributes[key] = value;
          return this;
        },
        setAttributes(attributes: Record<string, unknown>) {
          Object.assign(recorded.attributes, attributes);
          return this;
        },
        setStatus(status: { code: number; message?: string }) {
          recorded.status = status;
          return this;
        },
        recordException(exception: unknown) {
          recorded.exceptions.push(exception);
        },
        end() {
          recorded.endCalls += 1;
          recorded.ended = true;
        },
        spanContext() {
          return {
            traceId: 'a'.repeat(32),
            spanId: 'b'.repeat(16),
            traceFlags: 1,
          };
        },
        isRecording() {
          return true;
        },
        addEvent() {
          return this;
        },
        addLink() {
          return this;
        },
        updateName() {
          return this;
        },
      };

      return mockSpan as unknown as Span;
    },
  };

  return {
    tracer: tracer as unknown as Tracer,
    getSpans: () => spans,
    getStartSpanCalls: () => startSpanCalls,
  };
}

/** Minimal Express request stub — `withSpan` only reads `req.id`. */
function makeReq(id?: string): Request {
  return { id } as unknown as Request;
}

// ---------------------------------------------------------------------------
// withSpan with an injected in-memory tracer
// ---------------------------------------------------------------------------

describe('withSpan (in-memory tracer)', () => {
  let getSpans: () => RecordedSpan[];
  let getStartSpanCalls: () => number;

  beforeEach(() => {
    const mem = createInMemoryTracer();
    getSpans = mem.getSpans;
    getStartSpanCalls = mem.getStartSpanCalls;
    __setTracer(mem.tracer);
  });

  afterAll(() => {
    // Drop the cached mock tracer so later suites get the default one.
    __setTracer(trace.getTracer(TRACER_NAME));
  });

  it('returns the callback result and records a single OK span', async () => {
    const result = await withSpan(
      { name: 'GET /api/things', req: makeReq('req-1') },
      async () => 42,
    );

    expect(result).toBe(42);
    expect(getStartSpanCalls()).toBe(1);

    const [span] = getSpans();
    expect(span.name).toBe('GET /api/things');
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('attaches requestId from req.id and any custom attributes', async () => {
    await withSpan(
      {
        name: 'operation',
        req: makeReq('req-abc'),
        attributes: { developerId: 'dev-7', region: 'eu-west-1' },
      },
      async () => undefined,
    );

    const [span] = getSpans();
    expect(span.attributes.requestId).toBe('req-abc');
    expect(span.attributes.developerId).toBe('dev-7');
    expect(span.attributes.region).toBe('eu-west-1');
  });

  it('does not set requestId when the request has no id', async () => {
    await withSpan({ name: 'operation', req: makeReq() }, async () => undefined);

    const [span] = getSpans();
    expect(span.attributes).not.toHaveProperty('requestId');
  });

  it('passes the created span to the callback', async () => {
    let received: Span | undefined;

    await withSpan({ name: 'operation', req: makeReq('req-1') }, async (span) => {
      received = span;
    });

    expect(received).toBeDefined();
    expect(received?.isRecording()).toBe(true);
  });

  it('ends the span exactly once on success', async () => {
    await withSpan({ name: 'operation', req: makeReq('req-1') }, async () => undefined);

    const [span] = getSpans();
    expect(span.ended).toBe(true);
    expect(span.endCalls).toBe(1);
  });

  it('records the exception, sets ERROR status and rethrows the original error', async () => {
    const boom = new Error('boom');

    await expect(
      withSpan({ name: 'operation', req: makeReq('req-1') }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const [span] = getSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('boom');
    expect(span.exceptions).toEqual([boom]);
  });

  it('wraps non-Error rejections when recording the exception', async () => {
    await expect(
      withSpan({ name: 'operation', req: makeReq('req-1') }, () =>
        Promise.reject('not-an-error'),
      ),
    ).rejects.toBe('not-an-error');

    const [span] = getSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('not-an-error');
    expect(span.exceptions).toHaveLength(1);
    expect((span.exceptions[0] as Error).message).toBe('not-an-error');
  });

  it('ends the span exactly once even when the callback rejects', async () => {
    await expect(
      withSpan({ name: 'operation', req: makeReq('req-1') }, async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');

    const [span] = getSpans();
    expect(span.ended).toBe(true);
    expect(span.endCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withSpan when tracing is disabled (no SDK registered)
// ---------------------------------------------------------------------------

describe('withSpan when tracing is disabled', () => {
  beforeEach(() => {
    // With no SDK registered, the API returns a non-recording no-op tracer.
    // Injecting it explicitly mirrors the production default.
    __setTracer(trace.getTracer(TRACER_NAME));
  });

  it('does not create a recording span but still runs the callback', async () => {
    let observed: Span | undefined;

    const result = await withSpan({ name: 'operation', req: makeReq('req-1') }, async (span) => {
      observed = span;
      return 'done';
    });

    expect(result).toBe('done');
    expect(observed).toBeDefined();
    expect(observed?.isRecording()).toBe(false);
  });

  it('exposes a no-op span with an invalid span context', async () => {
    let observed: Span | undefined;

    await withSpan({ name: 'operation', req: makeReq('req-1') }, async (span) => {
      observed = span;
    });

    const context = observed?.spanContext();
    expect(context?.traceId).toBe('0'.repeat(32));
    expect(context?.spanId).toBe('0'.repeat(16));
    expect(context?.traceFlags).toBe(0);
  });
});
