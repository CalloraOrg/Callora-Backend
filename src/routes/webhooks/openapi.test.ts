import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

describe('docs/openapi.json — webhook examples', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  function readSpec(): JsonObject {
    return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
  }

  function asObject(value: unknown): JsonObject {
    return value as JsonObject;
  }

  test('documents webhook configuration retrieval and registration', () => {
    const spec = readSpec();
    const paths = asObject(spec.paths);
    const getOperation = asObject(asObject(paths['/api/webhooks/{developerId}']).get);
    const postOperation = asObject(asObject(paths['/api/webhooks']).post);

    expect(getOperation.summary).toBe('Get webhook configuration');
    expect(postOperation.summary).toBe('Register a webhook');
    expect(asObject(asObject(postOperation.requestBody).content)).toHaveProperty('application/json');

    const getResponse = asObject(asObject(getOperation.responses)['200']);
    const getExamples = asObject(
      asObject(asObject(getResponse.content)['application/json']).examples,
    );
    expect(getExamples.found).toBeDefined();
    expect(getExamples.foundNoRetryPolicy).toBeDefined();
    expect(asObject(asObject(getOperation.responses)['404'])).toBeDefined();

    const postExamples = asObject(
      asObject(asObject(asObject(postOperation.requestBody).content)['application/json']).examples,
    );
    expect(postExamples.registerFull).toBeDefined();
    expect(postExamples.registerMinimal).toBeDefined();
    const response201 = asObject(asObject(postOperation.responses)['201']);
    const successExamples = asObject(
      asObject(asObject(response201.content)['application/json']).examples,
    );
    expect(successExamples.registered).toBeDefined();
  });

  test('documents secret rotation and retry-policy update', () => {
    const paths = asObject(readSpec().paths);
    const rotate = asObject(asObject(paths['/api/webhooks/{developerId}/rotate-secret']).post);
    const retry = asObject(asObject(paths['/api/webhooks/{developerId}/retry-policy']).patch);

    expect(rotate.summary).toBe('Rotate webhook signing secret');
    expect(retry.summary).toBe('Update webhook retry policy');
    expect(rotate.responses).toHaveProperty('200');
    expect(rotate.responses).toHaveProperty('404');
    expect(retry.responses).toHaveProperty('200');
    expect(retry.responses).toHaveProperty('400');
    expect(retry.responses).toHaveProperty('404');
  });

  test('documents idempotent webhook deletion as a 200 response', () => {
    const paths = asObject(readSpec().paths);
    const operation = asObject(asObject(paths['/api/webhooks/{developerId}']).delete);
    const responses = asObject(operation.responses);

    expect(operation.summary).toBe('Remove webhook');
    expect(responses).toHaveProperty('200');
    expect(responses).not.toHaveProperty('404');
  });

  test('documents signed webhook delivery headers, examples, and response', () => {
    const paths = asObject(readSpec().paths);
    const operation = asObject(asObject(paths['/api/webhooks/deliver/{developerId}']).post);
    const parameters = operation.parameters as JsonObject[];
    const parameterNames = parameters.map((parameter) => parameter.name);

    expect(operation.summary).toBe('Deliver a signed webhook event');
    expect(parameterNames).toEqual(
      expect.arrayContaining([
        'X-Callora-Signature-256',
        'X-Callora-Timestamp',
        'X-Callora-Nonce',
      ]),
    );
    expect(operation.responses).toHaveProperty('200');
    expect(operation.responses).toHaveProperty('400');
    expect(operation.responses).toHaveProperty('401');
    expect(operation.responses).toHaveProperty('404');
  });

  test('defines webhook schemas and only the event types accepted by the route', () => {
    const schemas = asObject(asObject(readSpec().components).schemas);
    const expectedSchemas = [
      'WebhookEventType',
      'WebhookRetryPolicy',
      'WebhookRegisterRequest',
      'WebhookRegisterResponse',
      'WebhookConfig',
      'WebhookDeleteResponse',
      'WebhookRotateSecretResponse',
      'WebhookRetryPolicyUpdateRequest',
      'WebhookRetryPolicyUpdateResponse',
      'WebhookDeliveryPayload',
      'WebhookDeliveryResponse',
    ];
    for (const name of expectedSchemas) expect(schemas[name]).toBeDefined();

    expect(asObject(schemas.WebhookEventType).enum).toEqual([
      'new_api_call',
      'settlement_completed',
      'low_balance_alert',
    ]);
    expect(asObject(schemas.WebhookRetryPolicy).properties).toBeDefined();
  });
});