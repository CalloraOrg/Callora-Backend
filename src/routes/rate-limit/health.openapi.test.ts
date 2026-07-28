import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

describe('OpenAPI examples for /api/rate-limit/health', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  function readSpec(): JsonObject {
    return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
  }

  function asObject(value: unknown): JsonObject {
    return value as JsonObject;
  }

  test('documents operational and unconfigured 200 response examples', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/rate-limit/health']).get as JsonObject;
    const response200 = asObject(asObject(operation.responses)['200']);
    const examples = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );

    expect(examples.operational).toBeDefined();
    expect(asObject(asObject(examples.operational).value)).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );
    expect(examples.notConfigured).toBeDefined();
    expect(
      asObject(
        asObject(
          asObject(asObject(examples.notConfigured).value).dependencies,
        ).in_memory_store,
      ).details,
    ).toEqual({ note: 'No rate limiter configured for probing' });
  });

  test('documents the unavailable 503 response example', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/rate-limit/health']).get as JsonObject;
    const response503 = asObject(asObject(operation.responses)['503']);
    const examples = asObject(
      asObject(asObject(response503.content)['application/json']).examples,
    );
    const unavailable = asObject(examples.unavailable);

    expect(unavailable.summary).toBe('Rate-limit store probe failed');
    expect(
      asObject(
        asObject(asObject(unavailable.value).dependencies).in_memory_store,
      ),
    ).toEqual(
      expect.objectContaining({ status: 'down', error: 'unavailable' }),
    );
  });

  test('documents allowed and denied examples for the authenticated pre-check', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/limits/check']).get as JsonObject;
    const response200 = asObject(asObject(operation.responses)['200']);
    const examples = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );

    expect(asObject(examples.allowed).value).toEqual({ status: 'ok' });
    expect(asObject(examples.denied).value).toEqual({
      status: 'deny',
      reason: 'rate_limit_exceeded',
      retryAfterMs: 42300,
    });
  });
});
