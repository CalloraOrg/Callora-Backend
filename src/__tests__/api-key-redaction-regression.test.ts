import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { REDACTED_LOG_VALUE, redactLogValue } from '../logger.js';
import { logger, requestLogger } from '../middleware/logging.js';

describe('API Key Redaction Regression Tests', () => {
  describe('redactLogValue - common API key formats', () => {
    test('redacts standard x-api-key header format', async () => {
      const input = {
        headers: {
          'x-api-key': 'sk_live_51234567890abcdefghij',
          'content-type': 'application/json',
        },
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>).headers['x-api-key'], REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).headers['content-type'], 'application/json');
    });

    test('redacts authorization bearer tokens', async () => {
      const input = {
        headers: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
          'user-agent': 'Mozilla/5.0',
        },
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>).headers.authorization, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).headers['user-agent'], 'Mozilla/5.0');
    });

    test('redacts apiKey field in various cases', async () => {
      const input = {
        apiKey: 'ck_live_sensitive_key_123',
        ApiKey: 'ck_test_sensitive_key_456',
        API_KEY: 'sk_live_987654321',
        api_key: 'pk_live_abcdefghij',
        safe: 'value',
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>).apiKey, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).ApiKey, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).API_KEY, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).api_key, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).safe, 'value');
    });

    test('redacts token field in various cases', async () => {
      const input = {
        token: 'eyJhbGciOiJIUzI1NiJ9.eyJkYXRhIjoiYXV0aGVudGljIn0.4Adcj0u9wg_6Xvr8HFSd09X9Iv3SVE3hK9f2aBd3KbU',
        Token: 'sk_test_123456789',
        TOKEN: 'refresh_token_abc123xyz',
        safe: 'request-token-123', // should NOT be redacted - not exact key match
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>).token, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).Token, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).TOKEN, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).safe, 'request-token-123');
    });

    test('redacts admin/special API keys', async () => {
      const input = {
        'x-admin-api-key': 'admin_secret_key_123',
        'x-auth-token': 'auth_token_xyz',
        'proxy-authorization': 'proxy_secret_123',
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>)['x-admin-api-key'], REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>)['x-auth-token'], REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>)['proxy-authorization'], REDACTED_LOG_VALUE);
    });

    test('redacts nested API keys in request body', async () => {
      const input = {
        body: {
          user: {
            name: 'John',
            credentials: {
              apiKey: 'sk_live_secret_123',
              password: 'mypassword123',
              token: 'jwt_token_xyz',
            },
          },
          safe: 'data',
        },
      };

      const redacted = redactLogValue(input);

      const body = (redacted as Record<string, any>).body;
      assert.equal(body.user.credentials.apiKey, REDACTED_LOG_VALUE);
      assert.equal(body.user.credentials.password, REDACTED_LOG_VALUE);
      assert.equal(body.user.credentials.token, REDACTED_LOG_VALUE);
      assert.equal(body.safe, 'data');
    });

    test('redacts API keys in array of objects', async () => {
      const input = {
        webhooks: [
          { url: 'https://example.com/1', apiKey: 'webhook_key_1' },
          { url: 'https://example.com/2', apiKey: 'webhook_key_2' },
          { url: 'https://example.com/3', name: 'safe' },
        ],
      };

      const redacted = redactLogValue(input);

      const webhooks = (redacted as Record<string, any>).webhooks;
      assert.equal(webhooks[0].apiKey, REDACTED_LOG_VALUE);
      assert.equal(webhooks[0].url, 'https://example.com/1');
      assert.equal(webhooks[1].apiKey, REDACTED_LOG_VALUE);
      assert.equal(webhooks[2].name, 'safe');
    });

    test('redacts multiple sensitive keys in same object', async () => {
      const input = {
        headers: {
          authorization: 'Bearer token123',
          'x-api-key': 'api_key_123',
          'x-admin-api-key': 'admin_key_123',
        },
        body: {
          clientSecret: 'secret123',
          password: 'pass123',
          refreshToken: 'refresh123',
        },
      };

      const redacted = redactLogValue(input);

      const headers = (redacted as Record<string, any>).headers;
      const body = (redacted as Record<string, any>).body;

      assert.equal(headers.authorization, REDACTED_LOG_VALUE);
      assert.equal(headers['x-api-key'], REDACTED_LOG_VALUE);
      assert.equal(headers['x-admin-api-key'], REDACTED_LOG_VALUE);
      assert.equal(body.clientSecret, REDACTED_LOG_VALUE);
      assert.equal(body.password, REDACTED_LOG_VALUE);
      assert.equal(body.refreshToken, REDACTED_LOG_VALUE);
    });
  });

  describe('requestLogger - API key security in HTTP logs', () => {
    test('does not log request headers or body containing API keys', () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

      try {
        const req = {
          headers: {
            authorization: 'Bearer secret-token-should-not-leak',
            'x-api-key': 'sk_live_should_not_leak_123',
            'x-admin-api-key': 'admin-key-should-not-leak',
            'content-type': 'application/json',
          },
          method: 'POST',
          path: '/api/endpoint',
        } as unknown as Request;

        const res = new EventEmitter() as EventEmitter &
          Response & {
            statusCode: number;
            setHeader: jest.Mock;
          };
        res.statusCode = 200;
        res.setHeader = jest.fn();

        requestLogger(req, res, jest.fn());
        res.emit('finish');

        // The log should only contain safe metadata, not headers or body
        const [payload] = infoSpy.mock.calls[0] as [Record<string, unknown>, string];
        assert(!('headers' in payload), 'headers should not be in log payload');
        assert(!('body' in payload), 'body should not be in log payload');
        assert(payload.requestId, 'requestId should be in log payload');
        assert.equal(payload.method, 'POST');
      } finally {
        infoSpy.mockRestore();
      }
    });

    test('generates safe request ID without leaking secrets', () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);

      try {
        const req = {
          headers: {
            'x-request-id': 'safe-request-id-123',
            authorization: 'Bearer token-that-should-not-appear-anywhere',
          },
          method: 'GET',
          path: '/api/data',
        } as unknown as Request;

        const res = new EventEmitter() as EventEmitter &
          Response & {
            statusCode: number;
            setHeader: jest.Mock;
          };
        res.statusCode = 200;
        res.setHeader = jest.fn();

        requestLogger(req, res, jest.fn());
        res.emit('finish');

        // Verify that the authorization header doesn't leak into the request ID or logs
        expect(infoSpy.mock.calls[0][0]).toEqual({
          requestId: 'safe-request-id-123',
          method: 'GET',
          path: '/api/data',
          statusCode: 200,
          durationMs: expect.any(Number),
          clientIp: expect.any(String),
        });
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('logger.audit - API key redaction in audit logs', () => {
    test('redacts sensitive keys in audit event details', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        jest.resetModules();
        const { logger: loggerModule } = await import('../logger.js');

        loggerModule.audit('api_key_created', 'admin@example.com', {
          keyId: 'key_123',
          apiKey: 'sk_live_should_be_redacted_abc123',
          environment: 'production',
          expiresAt: '2024-12-31',
        });

        // The audit log should have redacted the apiKey
        expect(logSpy).toHaveBeenCalled();
        const logCall = logSpy.mock.calls[0][0];
        assert(typeof logCall === 'object', 'audit log should be an object');
        const auditLog = logCall as Record<string, any>;
        assert.equal(auditLog.type, 'AUDIT');
        assert.equal(auditLog.event, 'api_key_created');
        assert.equal(auditLog.actor, 'admin@example.com');
        assert.equal(auditLog.details.apiKey, REDACTED_LOG_VALUE);
        assert.equal(auditLog.details.keyId, 'key_123');
      } finally {
        logSpy.mockRestore();
        jest.resetModules();
      }
    });
  });

  describe('edge cases - API key redaction robustness', () => {
    test('redacts API keys in circular reference objects', async () => {
      const input: Record<string, any> = {
        apiKey: 'secret_key_123',
        safe: 'value',
      };
      input.circular = input; // Create circular reference

      const redacted = redactLogValue(input);

      // Should handle circular reference without crashing
      assert.equal((redacted as Record<string, any>).apiKey, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).safe, 'value');
    });

    test('redacts API keys in deeply nested structures', async () => {
      const input = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  apiKey: 'deep_secret_key_123',
                  safe: 'deep_value',
                },
              },
            },
          },
        },
      };

      const redacted = redactLogValue(input);

      const deepValue = ((((redacted as Record<string, any>).level1).level2).level3).level4.level5;
      assert.equal(deepValue.apiKey, REDACTED_LOG_VALUE);
      assert.equal(deepValue.safe, 'deep_value');
    });

    test('redacts API keys in mixed-type arrays', async () => {
      const input = {
        data: [
          'string_value',
          123,
          { apiKey: 'key_in_object' },
          null,
          undefined,
          { nested: { token: 'nested_token' } },
        ],
      };

      const redacted = redactLogValue(input);

      const data = (redacted as Record<string, any>).data;
      assert.equal(data[0], 'string_value');
      assert.equal(data[1], 123);
      assert.equal(data[2].apiKey, REDACTED_LOG_VALUE);
      assert.equal(data[3], null);
      assert.equal(data[4], undefined);
      assert.equal(data[5].nested.token, REDACTED_LOG_VALUE);
    });

    test('preserves error stack traces while redacting sensitive fields', async () => {
      const error = new Error('API authentication failed') as Error & {
        apiKey?: string;
        code?: string;
      };
      error.apiKey = 'sk_live_error_context_secret';
      error.code = 'AUTH_FAILED';

      const redacted = redactLogValue(error) as Record<string, unknown>;

      assert.equal(redacted.name, 'Error');
      assert.equal(redacted.message, 'API authentication failed');
      assert.equal(redacted.apiKey, REDACTED_LOG_VALUE);
      assert.equal(redacted.code, 'AUTH_FAILED');
      assert(typeof redacted.stack === 'string' && redacted.stack.length > 0, 'stack trace should be preserved');
    });

    test('handles API keys with special characters', async () => {
      const input = {
        apiKey: 'sk_live_!@#$%^&*()_+-=[]{}|;:,.<>?',
        password: 'p@ss!w0rd#special$chars%here',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>).apiKey, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).password, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).token, REDACTED_LOG_VALUE);
    });

    test('redacts all variations of "secret" field naming', async () => {
      const input = {
        secret: 'value1',
        Secret: 'value2',
        SECRET: 'value3',
        clientSecret: 'value4',
        ClientSecret: 'value5',
        webhookSecret: 'value6',
      };

      const redacted = redactLogValue(input);

      assert.equal((redacted as Record<string, any>).secret, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).Secret, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).SECRET, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).clientSecret, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).ClientSecret, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).webhookSecret, REDACTED_LOG_VALUE);
    });

    test('only redacts exact key matches, not substring matches', async () => {
      const input = {
        api_key_id: 'safe_id_123', // Contains "api_key" but not exact match
        user_token_id: 'safe_id_456', // Contains "token" but not exact match
        authorization_code: 'safe_code_789', // Contains "authorization" but not exact match
        apiKey: 'secret_123', // Exact match - should redact
        token: 'secret_456', // Exact match - should redact
        authorization: 'secret_789', // Exact match - should redact
      };

      const redacted = redactLogValue(input);

      // Non-exact matches should be preserved
      assert.equal((redacted as Record<string, any>).api_key_id, 'safe_id_123');
      assert.equal((redacted as Record<string, any>).user_token_id, 'safe_id_456');
      assert.equal((redacted as Record<string, any>).authorization_code, 'safe_code_789');
      // Exact matches should be redacted
      assert.equal((redacted as Record<string, any>).apiKey, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).token, REDACTED_LOG_VALUE);
      assert.equal((redacted as Record<string, any>).authorization, REDACTED_LOG_VALUE);
    });
  });

  describe('Pino logger - API key redaction via redact paths', () => {
    test('pino logger configuration includes common API key header paths', async () => {
      const { PINO_REDACT_PATHS } = await import('../logger.js');

      // Verify all common API key related headers are in redact paths
      const pathsToCheck = [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["x-auth-token"]',
        'req.headers["x-admin-api-key"]',
        'req.headers["proxy-authorization"]',
      ];

      for (const path of pathsToCheck) {
        assert(PINO_REDACT_PATHS.includes(path), `Path ${path} should be in PINO_REDACT_PATHS`);
      }
    });

    test('sensitive log keys set includes all common API key variations', async () => {
      const { redactLogValue, REDACTED_LOG_VALUE } = await import('../logger.js');

      // Test all key variations that should be redacted
      const sensitiveKeys = [
        'authorization',
        'cookie',
        'xapikey',
        'xauthtoken',
        'xadminapikey',
        'proxyauthorization',
        'password',
        'secret',
        'clientsecret',
        'apikey',
        'token',
        'accesstoken',
        'refreshtoken',
        'idtoken',
        'jwt',
      ];

      for (const key of sensitiveKeys) {
        const input = { [key]: `sensitive_value_for_${key}` };
        const redacted = redactLogValue(input);
        assert.equal(
          (redacted as Record<string, any>)[key],
          REDACTED_LOG_VALUE,
          `Key "${key}" should be redacted`,
        );
      }
    });
  });
});
