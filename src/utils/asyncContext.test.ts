import assert from 'node:assert/strict';

import {
  getOrCreateRequestId,
  getRequestId,
  runWithRequestContext,
} from './asyncContext.js';

describe('async request context', () => {
  test('stores request id across awaited async work', async () => {
    await runWithRequestContext({ requestId: 'req-als-123' }, async () => {
      await Promise.resolve();
      assert.equal(getRequestId(), 'req-als-123');
    });
  });

  test('falls back outside an inbound request context', () => {
    assert.equal(getRequestId(), undefined);
    assert.equal(getOrCreateRequestId(() => 'generated-fallback'), 'generated-fallback');
  });
});
