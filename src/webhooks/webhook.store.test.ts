import assert from 'node:assert/strict';
import { WebhookStore } from './webhook.store.js';
import { WebhookNonceStore } from './webhook.nonceStore.js';
import type { WebhookConfig } from './webhook.types.js';

function baseConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    developerId: 'dev-store',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    createdAt: new Date('2026-06-25T11:00:00.000Z'),
    ...overrides,
  };
}

describe('WebhookStore rotation + deletion', () => {
  beforeEach(() => {
    WebhookStore.clear();
  });

  it('rotateSecret keeps current and previous keys inside the grace window', () => {
    WebhookStore.register(baseConfig({
      developerId: 'dev-rot',
      secret_current: 'old-secret',
    }));

    const expiresAt = new Date('2026-06-26T12:00:00.000Z');
    const rotated = WebhookStore.rotateSecret('dev-rot', 'new-secret', expiresAt);
    assert.ok(rotated);
    assert.equal(rotated.secret_current, 'new-secret');
    assert.equal(rotated.secret_previous, 'old-secret');

    const now = new Date('2026-06-26T11:59:59.000Z');
    assert.deepEqual(WebhookStore.getActiveSecrets(rotated, now), ['new-secret', 'old-secret']);
  });

  it('getActiveSecrets deletes the previous key after the rotation window', () => {
    const config = baseConfig({
      secret_current: 'new-secret',
      secret_previous: 'old-secret',
      previous_expires_at: new Date('2026-06-26T12:00:00.000Z'),
    });
    WebhookStore.register(config);

    const stored = WebhookStore.get('dev-store')!;
    const afterWindow = new Date('2026-06-26T12:00:01.000Z');
    assert.deepEqual(WebhookStore.getActiveSecrets(stored, afterWindow), ['new-secret']);
    assert.equal(stored.secret_previous, undefined);
    assert.equal(stored.previous_expires_at, undefined);
  });

  it('delete removes the webhook and purges persisted nonces', () => {
    WebhookStore.register(baseConfig({
      secret_current: 'secret',
    }));
    assert.equal(WebhookNonceStore.consume('dev-store', 'nonce-abcdefghijklmnopqrst', 60_000), true);

    WebhookStore.delete('dev-store');
    assert.equal(WebhookStore.get('dev-store'), undefined);
    assert.equal(WebhookNonceStore.has('dev-store', 'nonce-abcdefghijklmnopqrst'), false);
  });

  it('a second rotation replaces the previous key rather than accumulating', () => {
    WebhookStore.register(baseConfig({
      developerId: 'dev-double',
      secret_current: 's0',
    }));
    const t1 = new Date('2026-06-26T12:00:00.000Z');
    WebhookStore.rotateSecret('dev-double', 's1', t1);
    const t2 = new Date('2026-06-27T12:00:00.000Z');
    WebhookStore.rotateSecret('dev-double', 's2', t2);

    const stored = WebhookStore.get('dev-double')!;
    assert.equal(stored.secret_current, 's2');
    assert.equal(stored.secret_previous, 's1');
    assert.deepEqual(
      WebhookStore.getActiveSecrets(stored, new Date('2026-06-26T12:00:00.000Z')),
      ['s2', 's1'],
    );
  });

  it('supports multiple webhook subscriptions per developer with independent secrets, retry policies, and deletion (#1241)', () => {
    const first = WebhookStore.register(baseConfig({
      developerId: 'dev-multi',
      url: 'https://finance.example.com/webhook',
      events: ['settlement_completed', 'new_api_call'],
      secret_current: 'finance-secret',
      retryPolicy: { maxRetries: 5, baseDelayMs: 2000 },
    }));

    const second = WebhookStore.register(baseConfig({
      developerId: 'dev-multi',
      url: 'https://monitoring.example.com/webhook',
      events: ['new_api_call', 'low_balance_alert'],
      secret_current: 'monitoring-secret',
      retryPolicy: { maxRetries: 2, baseDelayMs: 500 },
    }));

    assert.ok(first.id);
    assert.ok(second.id);
    assert.notEqual(first.id, second.id);

    // Both subscriptions receive matching event 'new_api_call'
    const matchingNewCall = WebhookStore.getByEvent('new_api_call');
    assert.equal(matchingNewCall.length, 2);
    assert.deepEqual(
      matchingNewCall.map((c) => c.url),
      ['https://finance.example.com/webhook', 'https://monitoring.example.com/webhook'],
    );

    // Legacy get(developerId) returns the first subscription
    const legacyFirst = WebhookStore.get('dev-multi');
    assert.equal(legacyFirst?.id, first.id);
    assert.equal(legacyFirst?.url, 'https://finance.example.com/webhook');

    // Each subscription maintains its own secret and retry policy
    const sub1 = WebhookStore.get('dev-multi', first.id);
    const sub2 = WebhookStore.get('dev-multi', second.id);
    assert.equal(sub1?.secret_current, 'finance-secret');
    assert.deepEqual(sub1?.retryPolicy, { maxRetries: 5, baseDelayMs: 2000 });
    assert.equal(sub2?.secret_current, 'monitoring-secret');
    assert.deepEqual(sub2?.retryPolicy, { maxRetries: 2, baseDelayMs: 500 });

    // Deleting one subscription leaves the other intact
    const deleted = WebhookStore.delete('dev-multi', first.id);
    assert.equal(deleted, true);
    assert.equal(WebhookStore.get('dev-multi', first.id), undefined);
    const remaining = WebhookStore.listByDeveloper('dev-multi');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, second.id);
    assert.equal(WebhookStore.get('dev-multi')?.id, second.id);
  });
});
