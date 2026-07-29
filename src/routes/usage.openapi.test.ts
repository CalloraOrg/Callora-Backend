/**
 * OpenAPI contract tests for usage endpoints.
 *
 * Verifies that docs/openapi.json contains well-formed, named examples for
 * every usage-related path:
 *
 *   GET /api/usage              — 200 (withEvents, withBuckets, empty, withCursorPagination)
 *                                  400 (invalidDateRange, invalidGroupBy, invalidCursor)
 *                                  401 (missingToken, expiredToken)
 *                                  500 (internalError)
 *
 *   GET /api/usage/sse          — 200 SSE event-stream (connected, usageEvent)
 *                                  401 (missingToken)
 *
 *   GET /api/usage/by-endpoint  — 200 (topEndpoints, filteredByApi, empty)
 *                                  400 (invalidDateRange, invalidLimit, invalidDate)
 *                                  401 (missingToken)
 *                                  500 (internalError)
 *
 * Also validates:
 *   - UsageResponse schema defines pagination and requestId fields
 *   - All example values contain the required keys/types
 *   - No accidental nesting or stray "responses" keys inside examples
 *
 * Closes #650
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OpenApiSpec = Record<string, unknown>;

function loadSpec(): OpenApiSpec {
  const specPath = path.join(process.cwd(), 'docs', 'openapi.json');
  return JSON.parse(fs.readFileSync(specPath, 'utf8')) as OpenApiSpec;
}

interface NamedExample {
  summary?: string;
  value?: Record<string, unknown>;
}

function getExamples(
  spec: OpenApiSpec,
  apiPath: string,
  method: string,
  statusCode: string,
  contentType = 'application/json',
): Record<string, NamedExample> {
  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const pathObj = paths[apiPath] as Record<string, unknown> | undefined;
  if (!pathObj) throw new Error(`Path not found in spec: ${apiPath}`);
  const methodObj = pathObj[method] as Record<string, unknown> | undefined;
  if (!methodObj) throw new Error(`Method ${method} not found at ${apiPath}`);
  const responses = methodObj.responses as Record<string, Record<string, unknown>>;
  const response = responses[statusCode];
  if (!response) throw new Error(`Status ${statusCode} not found at ${method.toUpperCase()} ${apiPath}`);
  const content = response.content as Record<string, Record<string, unknown>> | undefined;
  if (!content) throw new Error(`No content at ${statusCode} of ${method.toUpperCase()} ${apiPath}`);
  const mediaType = content[contentType];
  if (!mediaType) throw new Error(`Content-type ${contentType} not found at ${statusCode}`);
  const examples = mediaType.examples as Record<string, NamedExample> | undefined;
  if (!examples) throw new Error(`No named examples at ${statusCode} of ${method.toUpperCase()} ${apiPath} [${contentType}]`);
  return examples;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('OpenAPI examples — GET /api/usage', () => {
  let spec: OpenApiSpec;

  beforeAll(() => {
    spec = loadSpec();
  });

  // ── 200 ──────────────────────────────────────────────────────────────────

  describe('200 response', () => {
    it('defines named examples for the 200 response', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      expect(examples).toBeDefined();
    });

    it('includes a "withEvents" example with valid shape', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      expect(examples.withEvents).toBeDefined();
      expect(examples.withEvents.summary).toBe('Typical response with two usage events');

      const val = examples.withEvents.value!;
      expect(Array.isArray(val.events)).toBe(true);
      expect((val.events as unknown[]).length).toBeGreaterThan(0);

      const firstEvent = (val.events as Array<Record<string, unknown>>)[0];
      expect(typeof firstEvent.id).toBe('string');
      expect(typeof firstEvent.apiId).toBe('string');
      expect(typeof firstEvent.endpoint).toBe('string');
      expect(typeof firstEvent.occurredAt).toBe('string');
      expect(typeof firstEvent.revenue).toBe('string');

      const stats = val.stats as Record<string, unknown>;
      expect(typeof stats.totalCalls).toBe('number');
      expect(typeof stats.totalSpent).toBe('string');
      expect(Array.isArray(stats.breakdownByApi)).toBe(true);

      const period = val.period as Record<string, unknown>;
      expect(typeof period.from).toBe('string');
      expect(typeof period.to).toBe('string');
    });

    it('includes a "withBuckets" example containing stats.buckets', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      expect(examples.withBuckets).toBeDefined();

      const val = examples.withBuckets.value!;
      const stats = val.stats as Record<string, unknown>;
      expect(Array.isArray(stats.buckets)).toBe(true);
      const bucket = (stats.buckets as Array<Record<string, unknown>>)[0];
      expect(typeof bucket.period).toBe('string');
      expect(typeof bucket.calls).toBe('number');
      expect(typeof bucket.revenue).toBe('string');
    });

    it('includes an "empty" example with empty events and zero stats', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      expect(examples.empty).toBeDefined();

      const val = examples.empty.value!;
      expect(val.events).toEqual([]);

      const stats = val.stats as Record<string, unknown>;
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalSpent).toBe('0');
      expect(stats.breakdownByApi).toEqual([]);
    });

    it('includes a "withCursorPagination" example with nextCursor in pagination', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      expect(examples.withCursorPagination).toBeDefined();

      const val = examples.withCursorPagination.value!;
      const pagination = val.pagination as Record<string, unknown>;
      expect(typeof pagination.nextCursor).toBe('string');
      expect((pagination.nextCursor as string).length).toBeGreaterThan(0);
    });

    it('all 200 examples include a pagination object', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      for (const [name, ex] of Object.entries(examples)) {
        const val = ex.value!;
        expect(val.pagination).toBeDefined(`pagination missing in example "${name}"`);
        expect(typeof val.pagination).toBe('object');
      }
    });

    it('all 200 examples include a requestId string', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '200');
      for (const [name, ex] of Object.entries(examples)) {
        expect(typeof ex.value!.requestId).toBe('string', `requestId missing in example "${name}"`);
      }
    });
  });

  // ── 400 ──────────────────────────────────────────────────────────────────

  describe('400 response', () => {
    it('defines named examples for the 400 response', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '400');
      expect(examples).toBeDefined();
    });

    it('includes an "invalidDateRange" example', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '400');
      expect(examples.invalidDateRange).toBeDefined();
      const val = examples.invalidDateRange.value!;
      expect(val.success).toBe(false);
      const error = val.error as Record<string, unknown>;
      expect(error.code).toMatch(/VALIDATION_ERROR|BAD_REQUEST/);
      expect(typeof error.message).toBe('string');
    });

    it('includes an "invalidGroupBy" example', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '400');
      expect(examples.invalidGroupBy).toBeDefined();
      const val = examples.invalidGroupBy.value!;
      expect(val.success).toBe(false);
    });

    it('includes an "invalidCursor" example', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '400');
      expect(examples.invalidCursor).toBeDefined();
      const val = examples.invalidCursor.value!;
      expect(val.success).toBe(false);
      const error = val.error as Record<string, unknown>;
      expect(error.code).toBe('BAD_REQUEST');
    });

    it('all 400 examples have success=false', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '400');
      for (const [name, ex] of Object.entries(examples)) {
        expect(ex.value!.success).toBe(false, `success should be false in example "${name}"`);
      }
    });
  });

  // ── 401 ──────────────────────────────────────────────────────────────────

  describe('401 response', () => {
    it('defines named examples for the 401 response', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '401');
      expect(examples).toBeDefined();
    });

    it('includes a "missingToken" example with UNAUTHORIZED code', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '401');
      expect(examples.missingToken).toBeDefined();
      const error = examples.missingToken.value!.error as Record<string, unknown>;
      expect(error.code).toBe('UNAUTHORIZED');
    });

    it('includes an "expiredToken" example with TOKEN_EXPIRED code', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '401');
      expect(examples.expiredToken).toBeDefined();
      const error = examples.expiredToken.value!.error as Record<string, unknown>;
      expect(error.code).toBe('TOKEN_EXPIRED');
    });
  });

  // ── 500 ──────────────────────────────────────────────────────────────────

  describe('500 response', () => {
    it('defines named examples for the 500 response', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '500');
      expect(examples).toBeDefined();
    });

    it('includes an "internalError" example with INTERNAL_SERVER_ERROR code', () => {
      const examples = getExamples(spec, '/api/usage', 'get', '500');
      expect(examples.internalError).toBeDefined();
      const error = examples.internalError.value!.error as Record<string, unknown>;
      expect(error.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});

// ---------------------------------------------------------------------------

describe('OpenAPI examples — GET /api/usage/sse', () => {
  let spec: OpenApiSpec;

  beforeAll(() => {
    spec = loadSpec();
  });

  describe('200 text/event-stream response', () => {
    it('defines named examples for the SSE 200 response', () => {
      const examples = getExamples(spec, '/api/usage/sse', 'get', '200', 'text/event-stream');
      expect(examples).toBeDefined();
    });

    it('includes a "connected" example that is an SSE-formatted string', () => {
      const examples = getExamples(spec, '/api/usage/sse', 'get', '200', 'text/event-stream');
      expect(examples.connected).toBeDefined();
      expect(typeof examples.connected.value).toBe('string');
      expect((examples.connected.value as unknown as string)).toMatch(/event:\s*connected/);
    });

    it('includes a "usageEvent" example that is an SSE-formatted string with usage event data', () => {
      const examples = getExamples(spec, '/api/usage/sse', 'get', '200', 'text/event-stream');
      expect(examples.usageEvent).toBeDefined();
      expect(typeof examples.usageEvent.value).toBe('string');
      const raw = examples.usageEvent.value as unknown as string;
      expect(raw).toMatch(/event:\s*usage/);
      expect(raw).toContain('"apiId"');
      expect(raw).toContain('"occurredAt"');
    });
  });

  describe('401 response', () => {
    it('defines named examples for the SSE 401 response', () => {
      const examples = getExamples(spec, '/api/usage/sse', 'get', '401');
      expect(examples).toBeDefined();
    });

    it('includes a "missingToken" example with UNAUTHORIZED code', () => {
      const examples = getExamples(spec, '/api/usage/sse', 'get', '401');
      expect(examples.missingToken).toBeDefined();
      const error = examples.missingToken.value!.error as Record<string, unknown>;
      expect(error.code).toBe('UNAUTHORIZED');
    });
  });
});

// ---------------------------------------------------------------------------

describe('OpenAPI examples — GET /api/usage/by-endpoint', () => {
  let spec: OpenApiSpec;

  beforeAll(() => {
    spec = loadSpec();
  });

  describe('200 response', () => {
    it('defines named examples for the 200 response', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '200');
      expect(examples).toBeDefined();
    });

    it('includes a "topEndpoints" example with ranked endpoint data', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '200');
      expect(examples.topEndpoints).toBeDefined();

      const val = examples.topEndpoints.value!;
      expect(Array.isArray(val.data)).toBe(true);
      expect((val.data as unknown[]).length).toBeGreaterThan(0);

      const firstItem = (val.data as Array<Record<string, unknown>>)[0];
      expect(typeof firstItem.endpoint).toBe('string');
      expect(typeof firstItem.calls).toBe('number');
      expect(typeof firstItem.revenue).toBe('string');

      // First item must have more calls than second (ranked descending)
      if ((val.data as unknown[]).length > 1) {
        const second = (val.data as Array<Record<string, unknown>>)[1];
        expect(firstItem.calls as number).toBeGreaterThanOrEqual(second.calls as number);
      }

      const period = val.period as Record<string, unknown>;
      expect(typeof period.from).toBe('string');
      expect(typeof period.to).toBe('string');
    });

    it('includes a "filteredByApi" example', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '200');
      expect(examples.filteredByApi).toBeDefined();
      const val = examples.filteredByApi.value!;
      expect(Array.isArray(val.data)).toBe(true);
    });

    it('includes an "empty" example with no data', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '200');
      expect(examples.empty).toBeDefined();
      const val = examples.empty.value!;
      expect(val.data).toEqual([]);
    });
  });

  describe('400 response', () => {
    it('defines named examples for the 400 response', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '400');
      expect(examples).toBeDefined();
    });

    it('includes "invalidDateRange", "invalidLimit", and "invalidDate" examples', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '400');
      expect(examples.invalidDateRange).toBeDefined();
      expect(examples.invalidLimit).toBeDefined();
      expect(examples.invalidDate).toBeDefined();
    });

    it('all 400 examples have success=false with an error code', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '400');
      for (const [name, ex] of Object.entries(examples)) {
        expect(ex.value!.success).toBe(false, `success should be false in example "${name}"`);
        const error = ex.value!.error as Record<string, unknown>;
        expect(typeof error.code).toBe('string', `error.code missing in example "${name}"`);
        expect(typeof error.message).toBe('string', `error.message missing in example "${name}"`);
      }
    });
  });

  describe('401 response', () => {
    it('defines named examples for the 401 response', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '401');
      expect(examples).toBeDefined();
    });

    it('includes a "missingToken" example', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '401');
      expect(examples.missingToken).toBeDefined();
      const error = examples.missingToken.value!.error as Record<string, unknown>;
      expect(error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('500 response', () => {
    it('defines named examples for the 500 response', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '500');
      expect(examples).toBeDefined();
    });

    it('includes an "internalError" example', () => {
      const examples = getExamples(spec, '/api/usage/by-endpoint', 'get', '500');
      expect(examples.internalError).toBeDefined();
      const error = examples.internalError.value!.error as Record<string, unknown>;
      expect(error.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});

// ---------------------------------------------------------------------------

describe('OpenAPI spec integrity — usage-related schemas', () => {
  let spec: OpenApiSpec;

  beforeAll(() => {
    spec = loadSpec();
  });

  it('UsageResponse schema includes a pagination field', () => {
    const schemas = (spec.components as Record<string, unknown>)
      .schemas as Record<string, Record<string, unknown>>;
    const usageResponse = schemas.UsageResponse;
    expect(usageResponse).toBeDefined();
    const props = usageResponse.properties as Record<string, unknown>;
    expect(props.pagination).toBeDefined();
  });

  it('UsageResponse schema includes a requestId field', () => {
    const schemas = (spec.components as Record<string, unknown>)
      .schemas as Record<string, Record<string, unknown>>;
    const usageResponse = schemas.UsageResponse;
    const props = usageResponse.properties as Record<string, unknown>;
    expect(props.requestId).toBeDefined();
    const reqId = props.requestId as Record<string, unknown>;
    expect(reqId.type).toBe('string');
  });

  it('all usage path responses are valid JSON (no stray "responses" nesting)', () => {
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    const usagePaths = ['/api/usage', '/api/usage/sse', '/api/usage/by-endpoint'];
    for (const apiPath of usagePaths) {
      const pathObj = paths[apiPath] as Record<string, unknown>;
      const getMethod = pathObj.get as Record<string, unknown>;
      const responses = getMethod.responses as Record<string, Record<string, unknown>>;
      for (const [code, response] of Object.entries(responses)) {
        expect((response as Record<string, unknown>).responses).toBeUndefined(
          `Stray "responses" key found inside status ${code} of GET ${apiPath}`);
      }
    }
  });

  it('the spec file is valid JSON', () => {
    const specPath = path.join(process.cwd(), 'docs', 'openapi.json');
    expect(() => JSON.parse(fs.readFileSync(specPath, 'utf8'))).not.toThrow();
  });
});
