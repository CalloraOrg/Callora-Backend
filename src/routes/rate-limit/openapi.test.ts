import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

describe('docs/openapi.json — rate-limit examples', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  function readSpec(): JsonObject {
    return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
  }

  function asObject(value: unknown): JsonObject {
    return value as JsonObject;
  }

  test('file exists and contains a non-empty OpenAPI 3.1 document', () => {
    expect(fs.existsSync(openApiPath)).toBe(true);
    const spec = readSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(JSON.stringify(spec).length).toBeGreaterThan(1000);
  });

  test('documents GET /api/rate-limit/health and its response examples', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/rate-limit/health']).get as JsonObject;
    expect(operation.summary).toBe('Check rate-limit subsystem health');

    const response200 = asObject(asObject(operation.responses)['200']);
    const examples200 = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );
    expect(examples200.operational).toBeDefined();
    expect(examples200.notConfigured).toBeDefined();
    expect(asObject(asObject(examples200.operational).value)).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );
    expect(asObject(asObject(examples200.notConfigured).value)).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );

    const response503 = asObject(asObject(operation.responses)['503']);
    const examples503 = asObject(
      asObject(asObject(response503.content)['application/json']).examples,
    );
    expect(asObject(examples503.unavailable).summary).toBe('Rate-limit store probe failed');
    expect(
      asObject(
        asObject(
          asObject(asObject(examples503.unavailable).value).dependencies,
        ).in_memory_store,
      ),
    ).toEqual(expect.objectContaining({ status: 'down', error: 'unavailable' }));
  });

  test('documents GET /api/limits/check and allowed, denied, and unauthorized examples', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/limits/check']).get as JsonObject;
    expect(operation.summary).toBe("Check the authenticated user's rate-limit budget");
    expect(operation.security).toEqual([{ bearerAuth: [] }]);

    const response200 = asObject(asObject(operation.responses)['200']);
    const examples200 = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );
    expect(asObject(examples200.allowed).value).toEqual({ status: 'ok' });
    expect(asObject(examples200.denied).value).toEqual({
      status: 'deny',
      reason: 'rate_limit_exceeded',
      retryAfterMs: 42300,
    });

    const response401 = asObject(asObject(operation.responses)['401']);
    const examples401 = asObject(
      asObject(asObject(response401.content)['application/json']).examples,
    );
    expect(asObject(examples401.unauthorized).summary).toBe('Missing or invalid authentication');
  });

  test('defines bearerAuth and the rate-limit response schemas', () => {
    const spec = readSpec();
    const components = asObject(spec.components);
    const securitySchemes = asObject(components.securitySchemes);
    expect(asObject(securitySchemes.bearerAuth)).toEqual(
      expect.objectContaining({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }),
    );

    const schemas = asObject(components.schemas);
    expect(schemas.RateLimitHealthResponse).toBeDefined();
    expect(schemas.RateLimitCheckResponse).toBeDefined();
    expect(schemas.RateLimitDependencyStatus).toBeDefined();
    expect(schemas.ErrorResponse).toBeDefined();
  });
});