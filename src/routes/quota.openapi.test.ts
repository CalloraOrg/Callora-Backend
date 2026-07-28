import fs from 'node:fs';
import path from 'node:path';

describe('OpenAPI examples for quota requests', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  test('documents request, success, and error examples for the quota request endpoints', () => {
    const spec = JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as any;

    const listPath = spec.paths['/api/quota/requests'] as any;
    expect(listPath?.post).toBeDefined();
    expect(listPath?.get).toBeDefined();

    const createRequest = listPath.post.requestBody.content['application/json'].examples?.createRequest;
    expect(createRequest).toBeDefined();

    const createdResponse = listPath.post.responses['201'].content['application/json'].examples?.createdRequest;
    expect(createdResponse).toBeDefined();

    const listResponse = listPath.get.responses['200'].content['application/json'].examples?.listSuccess;
    expect(listResponse).toBeDefined();

    const invalidStatusExample = listPath.get.responses['400'].content['application/json'].examples?.invalidStatus;
    expect(invalidStatusExample).toBeDefined();

    const singlePath = spec.paths['/api/quota/requests/{id}'] as any;
    const singleResponse = singlePath.get.responses['200'].content['application/json'].examples?.singleRequest;
    expect(singleResponse).toBeDefined();
  });
});
