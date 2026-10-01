import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

function readSpec(): JsonObject {
  return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
}

function asObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function responseExamples(operation: JsonObject, status: string): JsonObject {
  const response = asObject(asObject(operation.responses)[status]);
  const content = asObject(response.content);
  const jsonContent = asObject(content['application/json']);
  return asObject(jsonContent.examples);
}

describe('docs/openapi.json — spike examples', () => {
  test('documents public spike paths and operations', () => {
    const paths = asObject(readSpec().paths);

    expect(asObject(paths['/api/spike'])).toHaveProperty('get');
    expect(asObject(paths['/api/spike'])).toHaveProperty('post');
    expect(asObject(paths['/api/spike/records'])).toHaveProperty('get');
    expect(asObject(paths['/api/spike/{id}'])).toHaveProperty('put');
    expect(asObject(paths['/api/spike/{id}'])).toHaveProperty('delete');
  });

  test('includes timeout probe examples and the supported delay parameter', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/spike']).get);
    const parameters = operation.parameters as JsonObject[];
    const delay = asObject(parameters[0]);
    const examples200 = responseExamples(operation, '200');
    const examples504 = responseExamples(operation, '504');

    expect(operation.summary).toBe('Run the spike timeout probe');
    expect(parameters.map((parameter) => parameter.name)).toEqual(['delay']);
    expect(asObject(delay.examples)).toHaveProperty('completesBeforeTimeout');
    expect(asObject(delay.examples)).toHaveProperty('exceedsDefaultTimeout');
    expect(asObject(asObject(examples200.completed).value)).toEqual(
      expect.objectContaining({ message: 'Spike completed successfully' }),
    );
    expect(asObject(asObject(examples504.timedOut).value).error).toEqual(
      expect.objectContaining({
        code: 'GATEWAY_TIMEOUT',
        message: 'Request timeout exceeded',
      }),
    );
  });

  test('includes create request, success, validation, and audit-unavailable examples', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/spike']).post);
    const requestExamples = asObject(
      asObject(asObject(asObject(operation.requestBody).content)['application/json']).examples,
    );
    const errors400 = responseExamples(operation, '400');
    const errors503 = responseExamples(operation, '503');

    expect(requestExamples).toHaveProperty('createHighSeverityRecord');
    expect(asObject(asObject(requestExamples.createHighSeverityRecord).value)).toEqual(
      expect.objectContaining({ label: 'Checkout latency spike', severity: 'high' }),
    );
    expect(asObject(errors400.missingLabel).value).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'label is required and must be a non-empty string',
        }),
      }),
    );
    expect(asObject(errors503.auditUnavailable).value).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Audit service temporarily unavailable' }),
      }),
    );
  });

  test('includes list, update, delete, and not-found examples', () => {
    const paths = asObject(readSpec().paths);
    const list = asObject(asObject(paths['/api/spike/records']).get);
    const listExamples = responseExamples(list, '200');
    const update = asObject(asObject(paths['/api/spike/{id}']).put);
    const updateExamples = responseExamples(update, '200');
    const deleteOperation = asObject(asObject(paths['/api/spike/{id}']).delete);
    const deleteExamples = responseExamples(deleteOperation, '404');

    expect(listExamples).toHaveProperty('withRecords');
    expect(asObject(asObject(listExamples.empty).value)).toEqual({ records: [] });
    expect(updateExamples).toHaveProperty('updated');
    expect(asObject(asObject(updateExamples.updated).value)).toEqual(
      expect.objectContaining({ label: 'Checkout latency spike escalated' }),
    );
    expect(asObject(deleteExamples.notFound).value).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'Spike record 999 not found' }),
      }),
    );
    expect(asObject(asObject(deleteOperation.responses)['204']).description).toBe('Spike record deleted.');
  });

  test('defines spike schemas and severity enum', () => {
    const schemas = asObject(asObject(readSpec().components).schemas);

    for (const name of [
      'SpikeRunResponse',
      'SpikeRecord',
      'SpikeRecordsResponse',
      'SpikeCreateRequest',
      'SpikeUpdateRequest',
    ]) {
      expect(schemas[name]).toBeDefined();
    }
    expect(asObject(schemas.SpikeSeverity).enum).toEqual(['low', 'medium', 'high', 'critical']);
  });
});
