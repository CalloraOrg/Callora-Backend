// Webhook URL validation is tested via integration tests in tests/integration/webhooks.test.ts.
// This file is intentionally minimal — it exists to satisfy the project test file convention
// for the webhook.validator module.

describe('webhook.validator module', () => {
  it('exists and is importable', async () => {
    const mod = await import('./webhook.validator.js');
    expect(mod).toBeDefined();
    expect(typeof mod.validateWebhookUrl).toBe('function');
  });
});
