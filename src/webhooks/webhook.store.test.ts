import { WebhookStore, WebhookDeliveryAttempt, FailedDeliveryEntry } from './webhook.store.js';
import { WebhookConfig, WebhookEventType, DeadLetterEntry } from './webhook.types.js';

describe('WebhookStore Unit Tests', () => {
  beforeEach(() => {
    WebhookStore.clear();
  });

  const sampleConfig: WebhookConfig = {
    developerId: 'dev-store-1',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    secret: 'my-secret',
    createdAt: new Date(),
  };

  it('registers, retrieves, lists, and queries by event', () => {
    WebhookStore.register(sampleConfig);

    const retrieved = WebhookStore.get('dev-store-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.developerId).toBe('dev-store-1');
    expect(retrieved?.secret_current).toBe('my-secret');

    const all = WebhookStore.list();
    expect(all).toHaveLength(1);

    const byEvent = WebhookStore.getByEvent('new_api_call');
    expect(byEvent).toHaveLength(1);

    const byOtherEvent = WebhookStore.getByEvent('settlement_completed');
    expect(byOtherEvent).toHaveLength(0);
  });

  it('updates retry policy', () => {
    expect(WebhookStore.updateRetryPolicy('non-existent', { maxRetries: 5 })).toBeUndefined();

    WebhookStore.register(sampleConfig);
    const updated = WebhookStore.updateRetryPolicy('dev-store-1', { maxRetries: 4, baseDelayMs: 2000 });
    expect(updated?.retryPolicy).toEqual({ maxRetries: 4, baseDelayMs: 2000 });
  });

  it('rotates secret and gets active secrets including grace period', () => {
    expect(WebhookStore.rotateSecret('non-existent', 'new-secret', new Date())).toBeUndefined();

    WebhookStore.register(sampleConfig);
    const futureDate = new Date(Date.now() + 60_000);
    const rotated = WebhookStore.rotateSecret('dev-store-1', 'new-secret', futureDate);

    expect(rotated?.secret_current).toBe('new-secret');
    expect(rotated?.secret_previous).toBe('my-secret');

    const activeSecrets = WebhookStore.getActiveSecrets(rotated!, new Date());
    expect(activeSecrets).toContain('new-secret');
    expect(activeSecrets).toContain('my-secret');

    // After grace period expires
    const pastDate = new Date(Date.now() + 120_000);
    const futureSecrets = WebhookStore.getActiveSecrets(rotated!, pastDate);
    expect(futureSecrets).toContain('new-secret');
    expect(futureSecrets).not.toContain('my-secret');
  });

  it('issues and verifies delete confirmation tokens', () => {
    expect(WebhookStore.issueDeleteToken('non-existent')).toBeUndefined();

    WebhookStore.register(sampleConfig);
    const tokenEntry = WebhookStore.issueDeleteToken('dev-store-1', 60_000);
    expect(tokenEntry).toBeDefined();

    expect(WebhookStore.verifyDeleteToken('dev-store-1', '').error).toBe('MISSING_TOKEN');
    expect(WebhookStore.verifyDeleteToken('dev-store-1', 'wrong-token').error).toBe('INVALID_TOKEN');

    const expiredEntry = WebhookStore.issueDeleteToken('dev-store-1', -100);
    expect(WebhookStore.verifyDeleteToken('dev-store-1', expiredEntry!.token).error).toBe('EXPIRED_TOKEN');

    expect(WebhookStore.verifyDeleteToken('dev-store-1', tokenEntry!.token).valid).toBe(true);
  });

  it('deletes subscription with cleanup of delivery attempts, failed deliveries, and DLQ', () => {
    const nonExistentResult = WebhookStore.deleteSubscriptionWithCleanup('non-existent');
    expect(nonExistentResult.deleted).toBe(false);

    WebhookStore.register(sampleConfig);

    const token1 = WebhookStore.issueDeleteToken('dev-store-1')!;
    const token2 = WebhookStore.issueDeleteToken('dev-store-1')!;

    const attempt: WebhookDeliveryAttempt = {
      deliveryId: 'del-1',
      developerId: 'dev-store-1',
      event: 'new_api_call',
      url: 'https://example.com/webhook',
      timestamp: new Date().toISOString(),
      status: 'failed',
      attempt: 1,
    };
    WebhookStore.recordDeliveryAttempt(attempt);

    const failedEntry: FailedDeliveryEntry = {
      deliveryId: 'del-2',
      developerId: 'dev-store-1',
      event: 'new_api_call',
      url: 'https://example.com/webhook',
      failedAt: new Date().toISOString(),
      lastError: 'HTTP 500',
      attempts: 5,
    };
    WebhookStore.recordFailedDelivery(failedEntry);

    const dlqEntry: DeadLetterEntry = {
      deliveryId: 'del-3',
      config: sampleConfig,
      payload: {
        event: 'new_api_call',
        timestamp: new Date().toISOString(),
        developerId: 'dev-store-1',
        data: {},
      },
      failedAt: new Date().toISOString(),
      lastError: 'HTTP 500',
      attempts: 5,
    };
    WebhookStore.addToDlq(dlqEntry);
    expect(WebhookStore.getFromDlq('del-3')).toBeDefined();
    expect(WebhookStore.dlqDepth()).toBe(1);

    const result = WebhookStore.deleteSubscriptionWithCleanup('dev-store-1', token1.token);
    expect(result.deleted).toBe(true);
    expect(result.prunedDeliveryAttempts).toBe(1);
    expect(result.prunedFailedDeliveries).toBe(1);
    expect(result.prunedDeadLetters).toBe(1);
    expect(result.beforeConfig?.developerId).toBe('dev-store-1');

    expect(WebhookStore.get('dev-store-1')).toBeUndefined();
    expect(WebhookStore.verifyDeleteToken('dev-store-1', token2.token).error).toBe('INVALID_TOKEN');
    expect(WebhookStore.getDeliveryAttempts('dev-store-1')).toHaveLength(0);
    expect(WebhookStore.getFromDlq('del-3')).toBeUndefined();
  });

  it('records failed deliveries with ring buffer overflow', () => {
    for (let i = 0; i < 205; i++) {
      WebhookStore.recordFailedDelivery({
        deliveryId: `del-${i}`,
        developerId: 'dev-store-1',
        event: 'new_api_call',
        url: 'https://example.com',
        failedAt: new Date().toISOString(),
        lastError: 'err',
        attempts: 5,
      });
    }

    const recent = WebhookStore.getRecentFailures(50);
    expect(recent).toHaveLength(50);
    expect(recent[0].deliveryId).toBe('del-204');
  });

  it('clears all stores cleanly', () => {
    WebhookStore.register(sampleConfig);
    WebhookStore.issueDeleteToken('dev-store-1');
    WebhookStore.clear();

    expect(WebhookStore.list()).toHaveLength(0);
  });
});
