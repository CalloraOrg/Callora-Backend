// Webhook URL validation is tested via integration tests in tests/integration/webhooks.test.ts.
// This file is intentionally minimal — it exists to satisfy the project test file convention
// for the webhook.validator module.

import { validateRetryPolicy, WebhookValidationError } from './webhook.validator.js';

describe('webhook.validator module', () => {
  it('exists and is importable', async () => {
    const mod = await import('./webhook.validator.js');
    expect(mod).toBeDefined();
    expect(typeof mod.validateWebhookUrl).toBe('function');
  });
});

describe('validateRetryPolicy', () => {
  const validPolicy = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
  };

  it('accepts a valid retry policy', () => {
    expect(validateRetryPolicy(validPolicy)).toEqual(validPolicy);
  });

  it('accepts a partial retry policy override', () => {
    expect(validateRetryPolicy({ maxAttempts: 2 })).toEqual({ maxAttempts: 2 });
  });

  it('rejects a non-object retry policy', () => {
    expect(() => validateRetryPolicy('bad')).toThrow(WebhookValidationError);
    expect(() => validateRetryPolicy('bad')).toThrow('retryPolicy must be an object');
  });

  it('rejects an empty retry policy', () => {
    expect(() => validateRetryPolicy({})).toThrow(WebhookValidationError);
    expect(() => validateRetryPolicy({})).toThrow('retryPolicy must include at least one override field');
  });

  it('rejects unsupported retry policy fields', () => {
    expect(() => validateRetryPolicy({ initialDelayMs: 1000 })).toThrow('retryPolicy.initialDelayMs is not supported');
  });

  it('rejects out-of-range maxAttempts', () => {
    expect(() => validateRetryPolicy({ ...validPolicy, maxAttempts: 0 })).toThrow('retryPolicy.maxAttempts must be an integer');
    expect(() => validateRetryPolicy({ ...validPolicy, maxAttempts: 21 })).toThrow('retryPolicy.maxAttempts must be an integer');
  });

  it('rejects maxDelayMs smaller than baseDelayMs', () => {
    expect(() => validateRetryPolicy({ ...validPolicy, baseDelayMs: 5000, maxDelayMs: 1000 })).toThrow(
      'retryPolicy.maxDelayMs must be greater than or equal to baseDelayMs'
    );
  });

  it('rejects out-of-range backoffMultiplier', () => {
    expect(() => validateRetryPolicy({ ...validPolicy, backoffMultiplier: 0.5 })).toThrow(
      'retryPolicy.backoffMultiplier must be a number between 1 and 10'
    );
    expect(() => validateRetryPolicy({ ...validPolicy, backoffMultiplier: 11 })).toThrow(
      'retryPolicy.backoffMultiplier must be a number between 1 and 10'
    );
  });
});
