import fs from "node:fs";
import path from "node:path";
import type { OpenAPI } from "openapi-types";

describe("OpenAPI Examples for /api/billing/deduct", () => {
  const openApiPath = path.join(process.cwd(), "docs", "openapi.json");

  test("OpenAPI spec contains examples for all required response codes", () => {
    const spec: OpenAPI.Document = JSON.parse(
      fs.readFileSync(openApiPath, "utf8"),
    );
    const deductPath = spec.paths?.["/api/billing/deduct"];

    expect(deductPath?.post).toBeDefined();

    const responses = deductPath!.post!.responses!;

    // Happy path (200) examples
    expect(responses["200"]).toBeDefined();
    expect(responses["200"].content!["application/json"].examples).toBeDefined();
    const successExample = responses["200"].content!["application/json"].examples!.success;
    expect((successExample as any).summary).toBe("Successful deduction");
    expect((successExample as any).value.success).toBe(true);
    expect((successExample as any).value.alreadyProcessed).toBe(false);

    const alreadyProcessedExample =
      responses["200"].content!["application/json"].examples!.alreadyProcessed;
    expect((alreadyProcessedExample as any).summary).toBe(
      "Already processed (idempotent)",
    );
    expect((alreadyProcessedExample as any).value.alreadyProcessed).toBe(true);

    // 409 Idempotency conflict example
    expect(responses["409"]).toBeDefined();
    const conflictExample =
      responses["409"].content!["application/json"].examples!
        .idempotencyConflict;
    expect((conflictExample as any).summary).toBe(
      "Idempotency key already used with different parameters",
    );
    expect((conflictExample as any).value.code).toBe("IDEMPOTENCY_CONFLICT");

    // 429 Rate limit example with Retry-After header
    expect(responses["429"]).toBeDefined();
    expect(responses["429"].headers).toBeDefined();
    expect(responses["429"].headers!["Retry-After"]).toBeDefined();
    const rateLimitedExample =
      responses["429"].content!["application/json"].examples!.rateLimited;
    expect((rateLimitedExample as any).summary).toBe("Too many requests");
    expect((rateLimitedExample as any).value.code).toBe("TOO_MANY_REQUESTS");
  });

  test("Request body examples contain required fields", () => {
    const spec: OpenAPI.Document = JSON.parse(
      fs.readFileSync(openApiPath, "utf8"),
    );
    const deductRequest =
      spec.paths!["/api/billing/deduct"].post!.requestBody!.content![
        "application/json"
      ].examples!.deductRequest;

    expect((deductRequest as any).summary).toBe("Deduct billing request");
    expect((deductRequest as any).value.requestId).toBeDefined();
    expect((deductRequest as any).value.apiId).toBeDefined();
    expect((deductRequest as any).value.endpointId).toBeDefined();
    expect((deductRequest as any).value.apiKeyId).toBeDefined();
    expect((deductRequest as any).value.amountUsdc).toBeDefined();
    expect((deductRequest as any).value.idempotencyKey).toBeDefined();
  });

  test("OpenAPI spec is valid JSON without nested responses object", () => {
    const spec: OpenAPI.Document = JSON.parse(
      fs.readFileSync(openApiPath, "utf8"),
    );
    const responses = spec.paths!["/api/billing/deduct"].post!.responses!;
    // The old malformed object had a nested "responses" key at every status code
    // This should not exist - each status code should be a response object
    for (const value of Object.values(responses)) {
      expect((value as any).responses).toBeUndefined();
    }
  });
});
