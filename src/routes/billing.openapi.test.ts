import fs from "node:fs";
import path from "node:path";

interface OpenApiExample {
  summary?: string;
  value?: Record<string, unknown>;
}

describe("OpenAPI Examples for /api/billing/deduct", () => {
  const openApiPath = path.join(process.cwd(), "docs", "openapi.json");

  test("OpenAPI spec contains examples for all required response codes", () => {
    const spec = JSON.parse(
      fs.readFileSync(openApiPath, "utf8"),
    ) as any;
    const deductPath = spec.paths["/api/billing/deduct"] as any;

    expect(deductPath?.post).toBeDefined();

    const responses = deductPath!.post!.responses;

    // Happy path (200) examples
    expect(responses["200"]).toBeDefined();
    expect(responses["200"].content["application/json"].examples).toBeDefined();
    const successExample = responses["200"].content["application/json"].examples.success;
    expect((successExample as OpenApiExample).summary).toBe("Successful deduction");
    expect((successExample as OpenApiExample).value?.success).toBe(true);
    expect((successExample as OpenApiExample).value?.alreadyProcessed).toBe(false);

    const alreadyProcessedExample =
      responses["200"].content["application/json"].examples.alreadyProcessed;
    expect((alreadyProcessedExample as OpenApiExample).summary).toBe(
      "Already processed (idempotent)",
    );
    expect((alreadyProcessedExample as OpenApiExample).value?.alreadyProcessed).toBe(true);

    // 409 Idempotency conflict example
    expect(responses["409"]).toBeDefined();
    const conflictExample =
      responses["409"].content["application/json"].examples
        .idempotencyConflict;
    expect((conflictExample as OpenApiExample).summary).toBe(
      "Idempotency key already used with different parameters",
    );
    expect((conflictExample as OpenApiExample).value?.code).toBe("IDEMPOTENCY_CONFLICT");

    // 429 Rate limit example with Retry-After header
    expect(responses["429"]).toBeDefined();
    expect(responses["429"].headers).toBeDefined();
    expect(responses["429"].headers["Retry-After"]).toBeDefined();
    const rateLimitedExample =
      responses["429"].content["application/json"].examples.rateLimited;
    expect((rateLimitedExample as OpenApiExample).summary).toBe("Too many requests");
    expect((rateLimitedExample as OpenApiExample).value?.code).toBe("TOO_MANY_REQUESTS");
  });

  test("Request body examples contain required fields", () => {
    const spec = JSON.parse(
      fs.readFileSync(openApiPath, "utf8"),
    ) as any;
    const deductRequest =
      spec.paths["/api/billing/deduct"].post.requestBody.content[
        "application/json"
      ].examples.deductRequest;

    expect((deductRequest as OpenApiExample).summary).toBe("Deduct billing request");
    expect((deductRequest as OpenApiExample).value?.requestId).toBeDefined();
    expect((deductRequest as OpenApiExample).value?.apiId).toBeDefined();
    expect((deductRequest as OpenApiExample).value?.endpointId).toBeDefined();
    expect((deductRequest as OpenApiExample).value?.apiKeyId).toBeDefined();
    expect((deductRequest as OpenApiExample).value?.amountUsdc).toBeDefined();
    expect((deductRequest as OpenApiExample).value?.idempotencyKey).toBeDefined();
  });

  test("OpenAPI spec is valid JSON without nested responses object", () => {
    const spec = JSON.parse(
      fs.readFileSync(openApiPath, "utf8"),
    ) as any;
    const responses = spec.paths["/api/billing/deduct"].post.responses;
    // The old malformed object had a nested "responses" key at every status code
    // This should not exist - each status code should be a response object
    for (const value of Object.values(responses)) {
      expect((value as Record<string, unknown>).responses).toBeUndefined();
    }
  });
});
