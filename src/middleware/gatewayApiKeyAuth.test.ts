import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { errorHandler } from './errorHandler.js';
import {
  API_KEY_PREFIX_LENGTH,
  createGatewayApiKeyAuthMiddleware,
  extractApiKey,
  type GatewayAuthCandidate,
} from './gatewayApiKeyAuth.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('gatewayApiKeyAuth middleware', () => {
  const validApiKey = 'ck_live_test_key_1234567890';
  const validPrefix = validApiKey.slice(0, API_KEY_PREFIX_LENGTH);
  const baseCandidate: GatewayAuthCandidate = {
    apiKeyRecord: {
      id: 'key_1',
      userId: 'user_1',
      apiId: 'api_1',
      prefix: validPrefix,
      keyHash: sha256Hex(validApiKey),
      revoked: false,
    },
    user: { id: 'user_1', stellar_address: 'GAUTH123' },
    vault: { id: 'vault_1', user_id: 'user_1', network: 'testnet' },
  };

  function buildApp(overrides?: {
    candidates?: GatewayAuthCandidate[];
    resolveApiContext?: () => { api: { id: string }; endpoint: { endpointId: string } } | null;
  }) {
    const app = express();
    app.use(express.json());

    app.get(
      '/gateway/:apiId',
      createGatewayApiKeyAuthMiddleware({
        async getApiKeyCandidates(prefix) {
          if (prefix !== validPrefix) {
            return [];
          }

          return overrides?.candidates ?? [baseCandidate];
        },
        resolveApiContext() {
          if (overrides && overrides.resolveApiContext !== undefined) {
            return overrides.resolveApiContext();
          }
          return {
            api: { id: 'api_1' },
            endpoint: { endpointId: 'ep_1' },
          };
        },
        getApiId(api) {
          return api.id;
        },
      }),
      (req, res) => {
        res.json({
          user: req.user,
          vault: req.vault,
          api: req.api,
          endpoint: req.endpoint,
          apiKeyRecord: req.apiKeyRecord,
          apiKeyValue: req.apiKeyValue,
        });
      },
    );

    app.use(errorHandler);
    return app;
  }

  it('extracts a bearer token as the API key', () => {
    const req = {
      header(name: string) {
        return name.toLowerCase() === 'authorization' ? `Bearer ${validApiKey}` : undefined;
      },
    } as unknown as express.Request;

    expect(extractApiKey(req)).toEqual({
      apiKey: validApiKey,
      source: 'authorization',
    });
  });

  it('extracts x-api-key when Authorization is absent', () => {
    const req = {
      header(name: string) {
        return name.toLowerCase() === 'x-api-key' ? validApiKey : undefined;
      },
    } as unknown as express.Request;

    expect(extractApiKey(req)).toEqual({
      apiKey: validApiKey,
      source: 'x-api-key',
    });
  });

  it('attaches the resolved auth context for a valid bearer key', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/gateway/api_1')
      .set('Authorization', `Bearer ${validApiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.apiKeyRecord.id).toBe('key_1');
    expect(res.body.user.id).toBe('user_1');
    expect(res.body.vault.id).toBe('vault_1');
    expect(res.body.api.id).toBe('api_1');
    expect(res.body.endpoint.endpointId).toBe('ep_1');
    expect(res.body.apiKeyValue).toBe(validApiKey);
  });

  it('accepts x-api-key header values', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/gateway/api_1')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    expect(res.body.apiKeyRecord.userId).toBe('user_1');
  });

  it('returns 401 when the API key is missing', async () => {
    const app = buildApp();

    const res = await request(app).get('/gateway/api_1');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized: missing API key');
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.requestId).toBeTruthy();
  });

  it('returns 401 when the Authorization header is malformed', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/gateway/api_1')
      .set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized: malformed Authorization header');
  });

  it('returns 401 when the prefix lookup misses', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/gateway/api_1')
      .set('x-api-key', 'ck_live_unknown_key');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized: API key not found');
  });

  it('returns 401 when the hash does not match the prefix candidate', async () => {
    const app = buildApp({
      candidates: [
        {
          ...baseCandidate,
          apiKeyRecord: {
            ...baseCandidate.apiKeyRecord,
            keyHash: sha256Hex('ck_live_test_key_different'),
          },
        },
      ],
    });

    const res = await request(app)
      .get('/gateway/api_1')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized: invalid API key');
  });

  it('returns 401 when the key has been revoked', async () => {
    const app = buildApp({
      candidates: [
        {
          ...baseCandidate,
          apiKeyRecord: {
            ...baseCandidate.apiKeyRecord,
            revoked: true,
          },
        },
      ],
    });

    const res = await request(app)
      .get('/gateway/api_1')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Unauthorized: API key has been revoked');
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 401 when the key is for a different API', async () => {
    const app = buildApp({
      candidates: [
        {
          ...baseCandidate,
          apiKeyRecord: {
            ...baseCandidate.apiKeyRecord,
            apiId: 'api_2',
          },
        },
      ],
    });

    const res = await request(app)
      .get('/gateway/api_1')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized: API key does not grant access to this API');
  });

  describe('scope enforcement', () => {
    function buildAppWithScope(overrides?: {
      candidates?: GatewayAuthCandidate[];
      requiredScope?: string;
      resolveApiContext?: () => { api: { id: string }; endpoint: { endpointId: string } } | null;
    }) {
      const app = express();
      app.use(express.json());

      app.get(
        '/gateway/:apiId',
        createGatewayApiKeyAuthMiddleware({
          requiredScope: overrides?.requiredScope ?? 'read',
          async getApiKeyCandidates(prefix) {
            if (prefix !== validPrefix) return [];
            return overrides?.candidates ?? [baseCandidate];
          },
          resolveApiContext() {
            if (overrides?.resolveApiContext !== undefined) return overrides.resolveApiContext();
            return { api: { id: 'api_1' }, endpoint: { endpointId: 'ep_1' } };
          },
          getApiId(api) { return api.id; },
        }),
        (req, res) => { res.json({ allowed: true }); },
      );

      app.use(errorHandler);
      return app;
    }

    it('allows a key with the required scope', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: ['read'] } }],
        requiredScope: 'read',
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(200);
      expect(res.body.allowed).toBe(true);
    });

    it('allows a key with wildcard scope', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: ['*'] } }],
        requiredScope: 'write',
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(200);
    });

    it('rejects a key missing the required scope with 403', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: ['read'] } }],
        requiredScope: 'write',
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Forbidden: API key lacks required scope');
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows a legacy key with no scopes (defaults to read-only) for read scope', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: [] } }],
        requiredScope: 'read',
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(200);
    });

    it('rejects a legacy key with no scopes for non-read scope', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: [] } }],
        requiredScope: 'write',
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(403);
    });

    it('allows a key with multiple scopes when one matches', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: ['read', 'write'] } }],
        requiredScope: 'read',
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(200);
    });

    it('omits scope check when requiredScope is not set (backward compat)', async () => {
      const app = buildAppWithScope({
        candidates: [{ ...baseCandidate, apiKeyRecord: { ...baseCandidate.apiKeyRecord, scopes: ['read'] } }],
        requiredScope: undefined,
      });

      const res = await request(app).get('/gateway/api_1').set('x-api-key', validApiKey);
      expect(res.status).toBe(200);
    });
  });

  it('returns 404 when the target API cannot be resolved', async () => {
    const app = buildApp({
      resolveApiContext: () => null,
    });

    const res = await request(app)
      .get('/gateway/api_1')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Not Found: unknown API');
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
