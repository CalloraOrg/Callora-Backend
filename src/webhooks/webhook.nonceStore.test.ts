import assert from 'node:assert/strict';
import { WebhookNonceStore } from './webhook.nonceStore.js';

describe('WebhookNonceStore', () => {
  beforeEach(() => {
    WebhookNonceStore.clear();
  });

  it('consumes a nonce once and rejects reuse', () => {
    assert.equal(WebhookNonceStore.consume('dev-1', 'nonce-abcdefghijklmnopqrst', 60_000), true);
    assert.equal(WebhookNonceStore.consume('dev-1', 'nonce-abcdefghijklmnopqrst', 60_000), false);
    assert.equal(WebhookNonceStore.has('dev-1', 'nonce-abcdefghijklmnopqrst'), true);
  });

  it('scopes nonces per developer', () => {
    assert.equal(WebhookNonceStore.consume('dev-a', 'nonce-abcdefghijklmnopqrst', 60_000), true);
    assert.equal(WebhookNonceStore.consume('dev-b', 'nonce-abcdefghijklmnopqrst', 60_000), true);
  });

  it('allows reuse after TTL expiry', () => {
    const now = 1_000_000;
    assert.equal(WebhookNonceStore.consume('dev-1', 'nonce-abcdefghijklmnopqrst', 1_000, now), true);
    assert.equal(WebhookNonceStore.consume('dev-1', 'nonce-abcdefghijklmnopqrst', 1_000, now + 500), false);
    assert.equal(WebhookNonceStore.consume('dev-1', 'nonce-abcdefghijklmnopqrst', 1_000, now + 1_001), true);
  });

  it('purgeScope deletes only that developer\'s nonces', () => {
    WebhookNonceStore.consume('dev-a', 'nonce-abcdefghijklmnopqrst', 60_000);
    WebhookNonceStore.consume('dev-b', 'nonce-abcdefghijklmnopqrst', 60_000);
    WebhookNonceStore.purgeScope('dev-a');
    assert.equal(WebhookNonceStore.has('dev-a', 'nonce-abcdefghijklmnopqrst'), false);
    assert.equal(WebhookNonceStore.has('dev-b', 'nonce-abcdefghijklmnopqrst'), true);
  });

  it('purgeExpired removes stale records', () => {
    const now = 5_000;
    WebhookNonceStore.consume('dev-1', 'nonce-abcdefghijklmnopqrst', 100, now);
    WebhookNonceStore.purgeExpired(now + 101);
    assert.equal(WebhookNonceStore.size(), 0);
  });
});
