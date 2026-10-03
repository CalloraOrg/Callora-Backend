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
  return asObject(asObject(content['application/json']).examples);
}

function requestExamples(operation: JsonObject): JsonObject {
  const requestBody = asObject(operation.requestBody);
  const content = asObject(requestBody.content);
  return asObject(asObject(content['application/json']).examples);
}

describe('docs/openapi.json — webhook contract', () => {
  test('documents every webhook operation under the expected path keys', () => {
    const paths = asObject(readSpec().paths);
    const developerPath = asObject(paths['/api/webhooks/{developerId}']);

    expect(paths).toHaveProperty('/api/webhooks');
    expect(paths).toHaveProperty('/api/webhooks/{developerId}/rotate-secret');
    expect(paths).toHaveProperty('/api/webhooks/{developerId}/retry-policy');
    expect(paths).toHaveProperty('/api/webhooks/deliver/{developerId}');
    expect(developerPath).toHaveProperty('get');
    expect(developerPath).toHaveProperty('delete');
    expect(Object.keys(paths).filter((key) => key === '/api/webhooks/{developerId}')).toHaveLength(1);
  });

  test('documents register request, success, and all validation examples', () => {
    const operation = asObject(asObject(asObject(readSpec().paths)['/api/webhooks']).post);
    const requests = requestExamples(operation);
    const success = responseExamples(operation, '201');
    const errors = responseExamples(operation, '400');

    expect(operation.summary).toBe('Register a webhook');
    expect(asObject(asObject(operation.requestBody).content)).toHaveProperty('application/json');
    expect(requests).toHaveProperty('registerFull');
    expect(requests).toHaveProperty('registerMinimal');
    expect(JSON.stringify(requests.registerFull)).toContain('s3cr3t-hmac-key');
    expect(JSON.stringify(requests.registerMinimal)).toContain('settlement_completed');
    expect(success).toHaveProperty('registered');
    expect(JSON.stringify(success.registered)).toContain('Webhook registered successfully.');
    for (const name of ['missingFields', 'invalidEventTypes', 'invalidUrl', 'invalidRetryPolicy']) {
      expect(errors[name]).toBeDefined();
    }
    expect(JSON.stringify(errors.invalidRetryPolicy)).toContain('retryPolicy.maxRetries must be between 0 and 10');
  });

  test('documents webhook retrieval with and without retry policy and not-found response', () => {
    const operation = asObject(
      asObject(asObject(readSpec().paths)['/api/webhooks/{developerId}']).get,
    );
    const success = responseExamples(operation, '200');
    const notFound = responseExamples(operation, '404');

    expect(operation.summary).toBe('Get webhook configuration');
    expect(success).toHaveProperty('found');
    expect(success).toHaveProperty('foundNoRetryPolicy');
    expect(JSON.stringify(success.found)).toContain('baseDelayMs');
    expect(JSON.stringify(notFound.notFound)).toContain('No webhook registered for this developer.');
    expect(JSON.stringify(notFound.notFound)).toContain('req-webhook-get-404');
  });

  test('documents idempotent webhook deletion as a 200 response', () => {
    const operation = asObject(
      asObject(asObject(readSpec().paths)['/api/webhooks/{developerId}']).delete,
    );
    const responses = asObject(operation.responses);
    const success = responseExamples(operation, '200');

    expect(operation.summary).toBe('Remove webhook');
    expect(responses).toHaveProperty('200');
    expect(responses).not.toHaveProperty('404');
    expect(JSON.stringify(success.removed)).toContain('Webhook removed.');
  });

  test('documents secret rotation and not-found response', () => {
    const operation = asObject(
      asObject(asObject(readSpec().paths)['/api/webhooks/{developerId}/rotate-secret']).post,
    );
    const success = responseExamples(operation, '200');
    const notFound = responseExamples(operation, '404');

    expect(operation.summary).toBe('Rotate webhook signing secret');
    expect(JSON.stringify(success.rotated)).toContain('Webhook secret rotated successfully.');
    expect(JSON.stringify(success.rotated)).toContain('previous_expires_at');
    expect(JSON.stringify(success.rotated)).toContain(
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    );
    expect(JSON.stringify(notFound.notFound)).toContain('req-webhook-rotate-404');
  });

  test('documents retry-policy requests, success, validation, and not-found examples', () => {
    const operation = asObject(
      asObject(asObject(readSpec().paths)['/api/webhooks/{developerId}/retry-policy']).patch,
    );
    const requests = requestExamples(operation);
    const success = responseExamples(operation, '200');
    const errors = responseExamples(operation, '400');
    const notFound = responseExamples(operation, '404');

    expect(operation.summary).toBe('Update webhook retry policy');
    expect(requests).toHaveProperty('setCustomPolicy');
    expect(requests).toHaveProperty('setMaxRetriesOnly');
    expect(JSON.stringify(requests.setCustomPolicy)).toContain('baseDelayMs');
    expect(JSON.stringify(requests.setMaxRetriesOnly)).toContain('maxRetries');
    expect(JSON.stringify(success.updated)).toContain('Webhook retry policy updated successfully.');
    expect(JSON.stringify(errors.maxRetriesOutOfRange)).toContain('req-webhook-retry-patch-400-range');
    expect(JSON.stringify(errors.emptyRetryPolicy)).toContain('req-webhook-retry-patch-400-empty');
    expect(JSON.stringify(errors.emptyRetryPolicy)).toContain(
      'retryPolicy must include maxRetries or baseDelayMs when provided',
    );
    expect(JSON.stringify(notFound.notFound)).toContain('req-webhook-retry-patch-404');
  });

  test('documents signed delivery headers, event examples, and response codes', () => {
    const operation = asObject(
      asObject(asObject(readSpec().paths)['/api/webhooks/deliver/{developerId}']).post,
    );
    const requests = requestExamples(operation);
    const parameters = operation.parameters as JsonObject[];
    const parameterNames = parameters.map((parameter) => parameter.name);
    const responses = asObject(operation.responses);

    expect(operation.summary).toBe('Deliver a signed webhook event');
    expect(parameterNames).toEqual(
      expect.arrayContaining([
        'X-Callora-Signature-256',
        'X-Callora-Timestamp',
        'X-Callora-Nonce',
      ]),
    );
    for (const name of ['newApiCall', 'settlementCompleted', 'lowBalanceAlert']) {
      expect(requests[name]).toBeDefined();
    }
    expect(JSON.stringify(requests.newApiCall)).toContain('latencyMs');
    expect(JSON.stringify(requests.settlementCompleted)).toContain('amountCredits');
    expect(JSON.stringify(requests.lowBalanceAlert)).toContain('thresholdCredits');
    expect(responseExamples(operation, '200')).toHaveProperty('accepted');
    for (const status of ['400', '401', '404']) expect(responses).toHaveProperty(status);
    expect(JSON.stringify(responseExamples(operation, '400').missingSignature)).toContain(
      'req-webhook-deliver-400-sig',
    );
    expect(JSON.stringify(responseExamples(operation, '401').invalidSignature)).toContain(
      'req-webhook-deliver-401-invalid',
    );
    expect(JSON.stringify(responseExamples(operation, '404').notFound)).toContain(
      'req-webhook-deliver-404',
    );
  });

  test('defines typed webhook schemas and only event types accepted by the route', () => {
    const schemas = asObject(asObject(readSpec().components).schemas);

    for (const name of [
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
    ]) {
      expect(schemas[name]).toBeDefined();
    }

    expect(asObject(schemas.WebhookEventType).enum).toEqual([
      'new_api_call',
      'settlement_completed',
      'low_balance_alert',
    ]);
    const retryProperties = asObject(asObject(schemas.WebhookRetryPolicy).properties);
    expect(asObject(retryProperties.maxRetries)).toEqual(
      expect.objectContaining({ minimum: 0, maximum: 10 }),
    );
    expect(asObject(retryProperties.baseDelayMs)).toEqual(
      expect.objectContaining({ minimum: 100, maximum: 60000 }),
    );
    expect(asObject(schemas.WebhookRegisterRequest).required).toEqual([
      'developerId',
      'url',
      'events',
    ]);
    expect(asObject(schemas.WebhookDeliveryPayload).required).toEqual([
      'event',
      'timestamp',
      'developerId',
      'data',
    ]);
  });
});
