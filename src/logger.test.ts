import assert from 'node:assert/strict';

describe('logger redaction helpers', () => {
  test('redactLogValue masks nested sensitive keys and preserves safe fields', async () => {
    const { redactLogValue, REDACTED_LOG_VALUE } = await import('./logger.js');

    const redacted = redactLogValue({
      authorization: 'Bearer secret-token',
      password: 'super-secret-password',
      nested: {
        apiKey: 'ck_live_sensitive',
        keep: 'ok',
      },
      array: [
        { token: 'abc123' },
        { safe: 'value' },
      ],
    });

    assert.deepEqual(redacted, {
      authorization: REDACTED_LOG_VALUE,
      password: REDACTED_LOG_VALUE,
      nested: {
        apiKey: REDACTED_LOG_VALUE,
        keep: 'ok',
      },
      array: [
        { token: REDACTED_LOG_VALUE },
        { safe: 'value' },
      ],
    });
  });

  test('redactLogValue masks sensitive properties attached to error objects', async () => {
    const { redactLogValue, REDACTED_LOG_VALUE } = await import('./logger.js');

    const error = new Error('request failed') as Error & {
      token?: string;
      context?: { secret: string; requestId: string };
    };
    error.token = 'jwt-token-value';
    error.context = {
      secret: 'webhook-secret',
      requestId: 'req-1',
    };

    const redacted = redactLogValue(error) as Record<string, unknown>;

    assert.equal(redacted.name, 'Error');
    assert.equal(redacted.message, 'request failed');
    assert.equal(redacted.token, REDACTED_LOG_VALUE);
    assert.deepEqual(redacted.context, {
      secret: REDACTED_LOG_VALUE,
      requestId: 'req-1',
    });
  });

  test('logger.info prefixes request id and redacts structured arguments', async () => {
    const originalLog = console.log;
    const logMock = jest.fn();

    try {
      // Reset modules and set the mock BEFORE importing so wrapLog(console.log)
      // captures the mocked version at module initialization time.
      jest.resetModules();
      console.log = logMock as unknown as typeof console.log;
      const { logger, runWithRequestContext, REDACTED_LOG_VALUE } = await import('./logger.js');

      runWithRequestContext({ requestId: 'req-123' }, () => {
        logger.info('auth failed', {
          headers: {
            authorization: 'Bearer should-not-leak',
          },
          keyHash: 'hashed-api-key',
          safe: 'value',
        });
      });

      expect(logMock.mock.calls).toHaveLength(1);
      expect(logMock.mock.calls[0]).toEqual([
        '[request_id:req-123]',
        'auth failed',
        {
          headers: {
            authorization: REDACTED_LOG_VALUE,
          },
          keyHash: REDACTED_LOG_VALUE,
          safe: 'value',
        },
      ]);
    } finally {
      console.log = originalLog;
      jest.resetModules();
    }
  });
});
