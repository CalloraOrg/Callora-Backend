import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

describe('OpenAPI examples for /api/errors', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  function readSpec(): JsonObject {
    return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
  }

  function asObject(value: unknown): JsonObject {
    return value as JsonObject;
  }

  test('documents populated and empty list examples for GET /api/errors', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/errors']).get as JsonObject;
    const response200 = asObject(asObject(operation.responses)['200']);
    const examples = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );

    expect(examples.withRecords).toBeDefined();
    const withRecordsValue = asObject(asObject(examples.withRecords).value);
    expect(withRecordsValue.success).toBe(true);
    const errors = asObject(withRecordsValue.data).errors as unknown[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toEqual(
      expect.objectContaining({ code: 'ERR_INSUFFICIENT_CREDITS', statusCode: 402 }),
    );

    expect(examples.empty).toBeDefined();
    const emptyValue = asObject(asObject(examples.empty).value);
    expect(asObject(emptyValue.data)).toEqual({ errors: [] });
  });

  test('documents create, validation-failure, and unauthorized examples for POST /api/errors', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/errors']).post as JsonObject;

    const response201 = asObject(asObject(operation.responses)['201']);
    const createdExamples = asObject(
      asObject(asObject(response201.content)['application/json']).examples,
    );
    expect(asObject(asObject(createdExamples.created).value)).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ code: 'ERR_INSUFFICIENT_CREDITS' }),
      }),
    );

    const response400 = asObject(asObject(operation.responses)['400']);
    const badRequestExamples = asObject(
      asObject(asObject(response400.content)['application/json']).examples,
    );
    const validationFailed = asObject(asObject(badRequestExamples.validationFailed).value);
    expect(asObject(validationFailed.error)).toEqual(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    );

    const response401 = asObject(asObject(operation.responses)['401']);
    const unauthorizedExamples = asObject(
      asObject(asObject(response401.content)['application/json']).examples,
    );
    expect(asObject(asObject(unauthorizedExamples.unauthorized).value)).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }),
    );
  });

  test('documents found and not-found examples for GET /api/errors/{id}', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/errors/{id}']).get as JsonObject;

    const response200 = asObject(asObject(operation.responses)['200']);
    const foundExamples = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );
    expect(asObject(asObject(foundExamples.found).value)).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ id: '1', code: 'ERR_INSUFFICIENT_CREDITS' }),
      }),
    );

    const response404 = asObject(asObject(operation.responses)['404']);
    const notFoundExamples = asObject(
      asObject(asObject(response404.content)['application/json']).examples,
    );
    expect(asObject(asObject(notFoundExamples.notFound).value)).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      }),
    );
  });

  test('documents update, empty-body, and not-found examples for PATCH /api/errors/{id}', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/errors/{id}']).patch as JsonObject;

    const response200 = asObject(asObject(operation.responses)['200']);
    const updatedExamples = asObject(
      asObject(asObject(response200.content)['application/json']).examples,
    );
    expect(asObject(asObject(updatedExamples.updated).value)).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          message: 'Account balance is below the required minimum',
        }),
      }),
    );

    const response400 = asObject(asObject(operation.responses)['400']);
    const emptyUpdateExamples = asObject(
      asObject(asObject(response400.content)['application/json']).examples,
    );
    expect(asObject(asObject(emptyUpdateExamples.emptyUpdate).value)).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: 'At least one field must be provided for update',
        }),
      }),
    );

    const response404 = asObject(asObject(operation.responses)['404']);
    const notFoundExamples = asObject(
      asObject(asObject(response404.content)['application/json']).examples,
    );
    expect(asObject(asObject(notFoundExamples.notFound).value)).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      }),
    );
  });

  test('documents no-content deletion response for DELETE /api/errors/{id}', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/errors/{id}']).delete as JsonObject;
    const response204 = asObject(asObject(operation.responses)['204']);
    expect(response204.description).toBeDefined();

    const response401 = asObject(asObject(operation.responses)['401']);
    const unauthorizedExamples = asObject(
      asObject(asObject(response401.content)['application/json']).examples,
    );
    expect(asObject(asObject(unauthorizedExamples.unauthorized).value)).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }),
    );
  });
});
