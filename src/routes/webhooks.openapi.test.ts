/**
 * Contract tests for src/openapi.yaml — /api/webhooks surface.
 *
 * Validates that the enriched examples added for GrantFox FWC26 cover every
 * webhook operation with proper typed schemas and realistic request/response
 * bodies, following the same string-presence pattern used by
 * src/routes/spike.openapi.test.ts.
 *
 * Operations covered:
 *   POST   /api/webhooks                          — register
 *   GET    /api/webhooks/{developerId}            — get config
 *   DELETE /api/webhooks/{developerId}            — remove
 *   POST   /api/webhooks/{developerId}/rotate-secret
 *   PATCH  /api/webhooks/{developerId}/retry-policy
 *   POST   /api/webhooks/deliver/{developerId}    — deliver signed event
 */

import fs from 'node:fs';
import path from 'node:path';

const yamlPath = path.join(process.cwd(), 'src', 'openapi.yaml');

function readOpenApiYaml(): string {
  return fs.readFileSync(yamlPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Path presence
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — /api/webhooks path presence', () => {
  test('documents all webhook paths', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('/api/webhooks:');
    expect(content).toContain('/api/webhooks/{developerId}:');
    expect(content).toContain('/api/webhooks/{developerId}/rotate-secret:');
    expect(content).toContain('/api/webhooks/{developerId}/retry-policy:');
    expect(content).toContain('/api/webhooks/deliver/{developerId}:');
  });

  test('consolidates GET and DELETE under a single /api/webhooks/{developerId} path key', () => {
    const content = readOpenApiYaml();

    // There must be exactly one occurrence of this path key (no duplicate)
    const occurrences = [...content.matchAll(/\/api\/webhooks\/\{developerId\}:/g)];
    expect(occurrences).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks — register
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — POST /api/webhooks register examples', () => {
  test('documents typed request body schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookRegisterRequest"');
  });

  test('documents full and minimal register request examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('registerFull:');
    expect(content).toContain('registerMinimal:');
    expect(content).toContain('s3cr3t-hmac-key');
    expect(content).toContain('settlement_completed');
  });

  test('documents 201 success response with typed schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookRegisterResponse"');
    expect(content).toContain('Webhook registered successfully.');
    expect(content).toContain('registered:');
  });

  test('documents 400 error examples for all failure modes', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('missingFields:');
    expect(content).toContain('developerId, url, and a non-empty events array are required.');
    expect(content).toContain('invalidEventTypes:');
    expect(content).toContain('Invalid event types:');
    expect(content).toContain('invalidUrl:');
    expect(content).toContain('URL is not reachable or does not return 2xx');
    expect(content).toContain('invalidRetryPolicy:');
    expect(content).toContain('retryPolicy.maxRetries must be between 0 and 10');
  });
});

// ---------------------------------------------------------------------------
// GET /api/webhooks/{developerId} — get config
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — GET /api/webhooks/{developerId} examples', () => {
  test('documents typed 200 response schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookConfig"');
  });

  test('documents found examples including one with and one without retry policy', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('found:');
    expect(content).toContain('foundNoRetryPolicy:');
    // Found example carries retryPolicy; minimal example does not
    expect(content).toContain('baseDelayMs: 1000');
  });

  test('documents 404 not-found example with StandardErrorEnvelope', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('No webhook registered for this developer.');
    expect(content).toContain('req-webhook-get-404');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/webhooks/{developerId} — remove
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — DELETE /api/webhooks/{developerId} examples', () => {
  test('documents typed 200 response schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookDeleteResponse"');
  });

  test('documents removal success example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('removed:');
    expect(content).toContain('Webhook removed.');
  });

  test('documents 404 example for DELETE', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('req-webhook-delete-404');
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/{developerId}/rotate-secret
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — POST rotate-secret examples', () => {
  test('documents typed 200 response schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookRotateSecretResponse"');
  });

  test('documents rotated success example with secret and expiry', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('rotated:');
    expect(content).toContain('Webhook secret rotated successfully.');
    expect(content).toContain('previous_expires_at:');
    // Secret is a 64-char hex string
    expect(content).toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2');
  });

  test('documents 404 example for rotate-secret', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('req-webhook-rotate-404');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/webhooks/{developerId}/retry-policy
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — PATCH retry-policy examples', () => {
  test('documents typed request body and response schema refs', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookRetryPolicyUpdateRequest"');
    expect(content).toContain('$ref: "#/components/schemas/WebhookRetryPolicyUpdateResponse"');
  });

  test('documents setCustomPolicy and setMaxRetriesOnly request examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('setCustomPolicy:');
    expect(content).toContain('setMaxRetriesOnly:');
    expect(content).toContain('baseDelayMs: 2000');
    expect(content).toContain('maxRetries: 10');
  });

  test('documents 200 updated example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('Webhook retry policy updated successfully.');
    expect(content).toContain('updated:');
  });

  test('documents 400 examples for out-of-range and empty retry policy', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('maxRetriesOutOfRange:');
    expect(content).toContain('req-webhook-retry-patch-400-range');
    expect(content).toContain('emptyRetryPolicy:');
    expect(content).toContain('retryPolicy must include maxRetries or baseDelayMs when provided');
    expect(content).toContain('req-webhook-retry-patch-400-empty');
  });

  test('documents 404 example for retry-policy update', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('req-webhook-retry-patch-404');
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/deliver/{developerId} — deliver signed event
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — POST deliver examples', () => {
  test('documents typed request body and response schema refs', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/WebhookDeliveryPayload"');
    expect(content).toContain('$ref: "#/components/schemas/WebhookDeliveryResponse"');
  });

  test('documents signature, timestamp, and nonce header parameters', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('X-Callora-Signature-256');
    expect(content).toContain('X-Callora-Timestamp');
    expect(content).toContain('X-Callora-Nonce');
  });

  test('documents three delivery request examples covering all supported event types', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('newApiCall:');
    expect(content).toContain('settlementCompleted:');
    expect(content).toContain('lowBalanceAlert:');
    // Event-specific data fields
    expect(content).toContain('latencyMs: 145');
    expect(content).toContain('amountCredits: 500');
    expect(content).toContain('thresholdCredits: 100');
  });

  test('documents 200 accepted example with echoed payload', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('Webhook delivery accepted.');
    expect(content).toContain('accepted:');
  });

  test('documents 400 missing-signature, 401 invalid-signature, and 404 examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('missingSignature:');
    expect(content).toContain('Missing required webhook signature headers');
    expect(content).toContain('req-webhook-deliver-400-sig');

    expect(content).toContain('invalidSignature:');
    expect(content).toContain('Webhook signature verification failed');
    expect(content).toContain('req-webhook-deliver-401-invalid');

    expect(content).toContain('req-webhook-deliver-404');
  });
});

// ---------------------------------------------------------------------------
// Component schemas
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — webhook component schemas', () => {
  test('defines all typed webhook schemas', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('WebhookEventType:');
    expect(content).toContain('WebhookRetryPolicy:');
    expect(content).toContain('WebhookRegisterRequest:');
    expect(content).toContain('WebhookRegisterResponse:');
    expect(content).toContain('WebhookConfig:');
    expect(content).toContain('WebhookDeleteResponse:');
    expect(content).toContain('WebhookRotateSecretResponse:');
    expect(content).toContain('WebhookRetryPolicyUpdateRequest:');
    expect(content).toContain('WebhookRetryPolicyUpdateResponse:');
    expect(content).toContain('WebhookDeliveryPayload:');
    expect(content).toContain('WebhookDeliveryResponse:');
  });

  test('WebhookEventType enumerates all supported event types', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('- new_api_call');
    expect(content).toContain('- settlement_completed');
    expect(content).toContain('- low_balance_alert');
    expect(content).toContain('- usage_event.created');
  });

  test('WebhookRetryPolicy enforces 0–10 maxRetries and 100–60000 ms baseDelayMs', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('minimum: 0');
    expect(content).toContain('maximum: 10');
    expect(content).toContain('minimum: 100');
    expect(content).toContain('maximum: 60000');
  });

  test('WebhookRegisterRequest marks developerId, url, and events as required', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('required: [developerId, url, events]');
  });

  test('WebhookDeliveryPayload marks all four fields as required', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('required: [event, timestamp, developerId, data]');
  });
});
