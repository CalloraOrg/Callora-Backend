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
});
