import {
  registerWebhookSchema,
  updateWebhookRetryPolicySchema,
  webhookDeliveryPayloadSchema,
  webhookDeveloperParamsSchema,
} from './webhooks.js';

describe('webhook validators', () => {
  it('accepts a valid registration payload', () => {
    const parsed = registerWebhookSchema.parse({
      developerId: 'dev-123',
      url: ' https://example.com/webhook ',
      events: ['new_api_call', 'usage_event.created'],
      secret: 'super-secret',
      retryPolicy: { maxRetries: 3, baseDelayMs: 500 },
    });

    expect(parsed).toEqual({
      developerId: 'dev-123',
      url: 'https://example.com/webhook',
      events: ['new_api_call', 'usage_event.created'],
      secret: 'super-secret',
      retryPolicy: { maxRetries: 3, baseDelayMs: 500 },
    });
  });

  it('rejects missing registration fields', () => {
    const result = registerWebhookSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['developerId', 'url', 'events']));
    }
  });

  it('rejects duplicate or unsupported events', () => {
    expect(registerWebhookSchema.safeParse({
      developerId: 'dev-123',
      url: 'https://example.com/webhook',
      events: ['new_api_call', 'new_api_call'],
    }).success).toBe(false);

    expect(registerWebhookSchema.safeParse({
      developerId: 'dev-123',
      url: 'https://example.com/webhook',
      events: ['not_real'],
    }).success).toBe(false);
  });

  it('rejects unknown registration fields and short secrets', () => {
    const result = registerWebhookSchema.safeParse({
      developerId: 'dev-123',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      secret: 'short',
      admin: true,
    });

    expect(result.success).toBe(false);
  });

  it('validates developer route params', () => {
    expect(webhookDeveloperParamsSchema.parse({ developerId: 'dev_123' })).toEqual({ developerId: 'dev_123' });
    expect(webhookDeveloperParamsSchema.safeParse({ developerId: 'x' }).success).toBe(false);
  });

  it('accepts omitted retry policy and validates provided retry limits', () => {
    expect(updateWebhookRetryPolicySchema.parse({})).toEqual({});
    expect(updateWebhookRetryPolicySchema.parse({ retryPolicy: { maxRetries: 0 } })).toEqual({
      retryPolicy: { maxRetries: 0 },
    });
    expect(updateWebhookRetryPolicySchema.safeParse({ retryPolicy: { maxRetries: 11 } }).success).toBe(false);
    expect(updateWebhookRetryPolicySchema.safeParse({ retryPolicy: {} }).success).toBe(false);
  });

  it('validates signed delivery payload shape', () => {
    const payload = {
      event: 'invoice_created',
      timestamp: '2026-07-28T00:00:00.000Z',
      developerId: 'dev-123',
      data: { invoiceId: 'inv-1' },
    };

    expect(webhookDeliveryPayloadSchema.parse(payload)).toEqual(payload);
    expect(webhookDeliveryPayloadSchema.safeParse({ ...payload, timestamp: 'today' }).success).toBe(false);
  });
});
