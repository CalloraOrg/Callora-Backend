import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

describe('OpenAPI examples for API marketplace routes', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  function readSpec(): JsonObject {
    return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
  }

  function asObject(value: unknown): JsonObject {
    return value as JsonObject;
  }

  function responseJson(responses: JsonObject, status: string): JsonObject {
    return asObject(asObject(asObject(responses[status]).content)['application/json']);
  }

  function exampleFromResponse(
    responses: JsonObject,
    status: string,
    exampleKey: string,
  ): JsonObject {
    return asObject(asObject(responseJson(responses, status).examples)[exampleKey]);
  }

  test('documents examples for listing and publishing APIs', () => {
    const spec = readSpec();
    const apisPath = asObject(asObject(spec.paths)['/api/apis']);
    const listOperation = asObject(apisPath.get);
    const listResponses = asObject(listOperation.responses);
    const listResponse200 = asObject(listResponses['200']);
    const listJson = asObject(asObject(listResponse200.content)['application/json']);

    const listExample = asObject(asObject(listJson.examples).activeListings);
    expect(listExample).toBeDefined();
    expect(listExample.summary).toBe('Active API listings page');
    const listExampleValue = asObject(listExample.value);
    expect(listExampleValue.meta).toMatchObject({
      limit: 20,
      hasMore: false,
    });
    expect((listExampleValue.data as unknown[])[0]).toEqual(
      expect.objectContaining({
        id: 101,
        name: 'GrantFox Scoring API',
        category: 'grants',
      }),
    );

    const postOperation = asObject(apisPath.post);
    const requestBody = asObject(postOperation.requestBody);
    const postJson = asObject(asObject(requestBody.content)['application/json']);
    const createRequest = asObject(asObject(postJson.examples).publishApi);
    expect(createRequest).toBeDefined();
    const createRequestValue = asObject(createRequest.value);
    expect(createRequestValue.endpoints).toHaveLength(2);
    expect((createRequestValue.endpoints as unknown[])[0]).toEqual(
      expect.objectContaining({
        path: '/applications/{applicationId}/review',
        method: 'POST',
      }),
    );

    const postResponses = asObject(postOperation.responses);
    const createdApi = exampleFromResponse(postResponses, '201', 'createdApi');
    expect(createdApi).toBeDefined();
    const createdApiValue = asObject(createdApi.value);
    expect(createdApiValue.status).toBe('active');
    expect(createdApiValue.endpoints).toHaveLength(2);

    const invalidPayload = exampleFromResponse(postResponses, '400', 'invalidPayload');
    expect(invalidPayload).toBeDefined();
    expect(asObject(invalidPayload.value).code).toBe('BAD_REQUEST');

    const unauthorized = exampleFromResponse(postResponses, '401', 'unauthorized');
    expect(unauthorized).toBeDefined();
    expect(asObject(unauthorized.value).code).toBe('UNAUTHORIZED');
  });

  test('documents detail lookup examples for a single API', () => {
    const spec = readSpec();
    const singlePath = asObject(asObject(spec.paths)['/api/apis/{id}']);
    const getOperation = asObject(singlePath.get);
    const getResponses = asObject(getOperation.responses);

    const detailExample = exampleFromResponse(getResponses, '200', 'apiDetails');
    expect(detailExample).toBeDefined();
    expect(asObject(asObject(detailExample.value).developer)).toEqual({
      id: 11,
      name: 'GrantFox Labs',
    });
    expect(asObject(detailExample.value).endpoints).toHaveLength(2);

    const invalidId = exampleFromResponse(getResponses, '400', 'invalidId');
    expect(invalidId).toBeDefined();
    expect(asObject(invalidId.value).message).toBe('id must be a positive integer');

    const notFound = exampleFromResponse(getResponses, '404', 'apiNotFound');
    expect(notFound).toBeDefined();
    expect(asObject(notFound.value).code).toBe('NOT_FOUND');
  });

  test('documents bulk endpoint registration examples', () => {
    const spec = readSpec();
    const bulkPath = asObject(asObject(spec.paths)['/api/apis/{id}/endpoints/bulk']);
    const postOperation = asObject(bulkPath.post);
    const requestBody = asObject(postOperation.requestBody);
    const postJson = asObject(asObject(requestBody.content)['application/json']);
    const responses = asObject(postOperation.responses);

    const requestExample = asObject(asObject(postJson.examples).bulkRegisterEndpoints);
    expect(requestExample).toBeDefined();
    expect(asObject(requestExample.value).endpoints).toHaveLength(2);

    const createdEndpoints = exampleFromResponse(responses, '201', 'createdEndpoints');
    expect(createdEndpoints).toBeDefined();
    expect((asObject(createdEndpoints.value).endpoints as unknown[])[0]).toEqual(
      expect.objectContaining({
        api_id: 301,
        method: 'POST',
      }),
    );

    const invalidEndpoint = exampleFromResponse(responses, '400', 'invalidEndpoint');
    expect(invalidEndpoint).toBeDefined();
    expect((asObject(invalidEndpoint.value).details as JsonObject[])[0].field).toBe(
      'endpoints.0.price_per_call_usdc',
    );

    const tooManyEndpoints = exampleFromResponse(responses, '400', 'tooManyEndpoints');
    expect(tooManyEndpoints).toBeDefined();
    expect(asObject(tooManyEndpoints.value).message).toContain('more than 50 endpoints');

    const unauthorized = exampleFromResponse(responses, '401', 'unauthorized');
    expect(unauthorized).toBeDefined();

    const notFound = exampleFromResponse(responses, '404', 'apiNotFound');
    expect(notFound).toBeDefined();
    expect(asObject(notFound.value).message).toBe('API not found');
  });
});
