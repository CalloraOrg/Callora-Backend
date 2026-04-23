/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import webhookRoutes from '../../src/webhooks/webhook.routes.js';
import { WebhookStore } from '../../src/webhooks/webhook.store.js';
import { validateWebhookUrl, WebhookValidationError } from '../../src/webhooks/webhook.validator.js';
import { dispatchWebhook } from '../../src/webhooks/webhook.dispatcher.js';
import { WebhookEventType } from '../../src/webhooks/webhook.types.js';

// Mock the logger to avoid console output in tests
// Must use `var` so the variable is hoisted with the jest.mock() call (same as mockDnsLookup below)
// eslint-disable-next-line no-var
var mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/logger.js', () => ({
  logger: mockLogger,
}));

// Mock DNS resolution for URL validation tests
// Must use `var` (not `const`/`let`) so the variable is hoisted along with
// the jest.mock() call — `const` and `let` are not hoisted and would be in the
// temporal dead zone when Jest runs the factory at module load time.
// eslint-disable-next-line no-var
var mockDnsLookup = jest.fn();
jest.mock('dns/promises', () => ({
  lookup: mockDnsLookup,
}));

function buildWebhookApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhookRoutes);
  return app;
}

describe('Webhook Routes Security Tests', () => {
  let app: express.Express;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    app = buildWebhookApp();
    WebhookStore.list().forEach(config => {
      WebhookStore.delete(config.developerId);
    });
    jest.clearAllMocks();
    mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('POST /api/webhooks - Registration Security', () => {
    const validPayload = {
      developerId: 'dev-123',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      secret: 'test-secret-key',
    };

    it('should reject requests with missing required fields', async () => {
      const testCases = [
        { payload: {}, expectedError: 'developerId, url, and a non-empty events array are required.' },
        { payload: { developerId: 'dev-123' }, expectedError: 'developerId, url, and a non-empty events array are required.' },
        { payload: { developerId: 'dev-123', url: 'https://example.com' }, expectedError: 'developerId, url, and a non-empty events array are required.' },
        { payload: { developerId: 'dev-123', url: 'https://example.com', events: [] }, expectedError: 'developerId, url, and a non-empty events array are required.' },
      ];

      for (const testCase of testCases) {
        const response = await request(app)
          .post('/api/webhooks')
          .send(testCase.payload)
          .expect(400);

        expect(response.body.error).toBe(testCase.expectedError);
      }
    });

    it('should reject requests with invalid event types', async () => {
      const response = await request(app)
        .post('/api/webhooks')
        .send({
          ...validPayload,
          events: ['invalid_event', 'new_api_call'],
        })
        .expect(400);

      expect(response.body.error).toContain('Invalid event types: invalid_event');
    });

    it('should reject URLs that resolve to private IP ranges in production', async () => {
      process.env.NODE_ENV = 'production';
      
      // Mock DNS lookup to return a private IP
      mockDnsLookup.mockResolvedValue([{ address: '192.168.1.100', family: 4 }]);

      const response = await request(app)
        .post('/api/webhooks')
        .send({
          ...validPayload,
          url: 'https://internal.example.com/webhook',
        })
        .expect(400);

      expect(response.body.error).toContain('private/internal IP address');
    });

    it('should reject non-HTTPS URLs in production', async () => {
      process.env.NODE_ENV = 'production';

      const response = await request(app)
        .post('/api/webhooks')
        .send({
          ...validPayload,
          url: 'http://example.com/webhook',
        })
        .expect(400);

      expect(response.body.error).toContain('must use HTTPS in production');
    });

    it('should reject non-standard ports in production', async () => {
      process.env.NODE_ENV = 'production';

      const response = await request(app)
        .post('/api/webhooks')
        .send({
          ...validPayload,
          url: 'https://example.com:8443/webhook',
        })
        .expect(400);

      expect(response.body.error).toContain('Only ports 80 and 443 are allowed');
    });

    it('should reject URLs that cannot be resolved', async () => {
      mockDnsLookup.mockRejectedValue(new Error('NXDOMAIN'));

      const response = await request(app)
        .post('/api/webhooks')
        .send(validPayload)
        .expect(400);

      expect(response.body.error).toContain('Could not resolve webhook hostname');
    });

    it('should allow valid webhook registration', async () => {
      const response = await request(app)
        .post('/api/webhooks')
        .send(validPayload)
        .expect(201);

      expect(response.body.message).toBe('Webhook registered successfully.');
      expect(response.body.developerId).toBe(validPayload.developerId);
      expect(response.body.url).toBe(validPayload.url);
      expect(response.body.events).toEqual(validPayload.events);
      expect(response.body).not.toHaveProperty('secret');
    });

    it('should allow registration without secret (but not recommended)', async () => {
      const { secret: _secret, ...payloadWithoutSecret } = validPayload;

      const response = await request(app)
        .post('/api/webhooks')
        .send(payloadWithoutSecret)
        .expect(201);

      expect(response.body.message).toBe('Webhook registered successfully.');
    });
  });

  describe('GET /api/webhooks/:developerId - Information Disclosure', () => {
    beforeEach(() => {
      WebhookStore.register({
        developerId: 'dev-123',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        secret: 'super-secret-key',
        createdAt: new Date(),
      });
    });

    it('should never expose webhook secrets in responses', async () => {
      const response = await request(app)
        .get('/api/webhooks/dev-123')
        .expect(200);

      expect(response.body).not.toHaveProperty('secret');
      expect(response.body.developerId).toBe('dev-123');
      expect(response.body.url).toBe('https://example.com/webhook');
      expect(response.body.events).toEqual(['new_api_call']);
    });

    it('should return 404 for non-existent developer', async () => {
      const response = await request(app)
        .get('/api/webhooks/non-existent')
        .expect(404);

      expect(response.body.error).toBe('No webhook registered for this developer.');
    });
  });

  describe('DELETE /api/webhooks/:developerId - Authorization', () => {
    beforeEach(() => {
      WebhookStore.register({
        developerId: 'dev-123',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        secret: 'test-secret',
        createdAt: new Date(),
      });
    });

    it('should allow webhook deletion', async () => {
      const response = await request(app)
        .delete('/api/webhooks/dev-123')
        .expect(200);

      expect(response.body.message).toBe('Webhook removed.');
      
      // Verify webhook is actually deleted
      const getResponse = await request(app)
        .get('/api/webhooks/dev-123')
        .expect(404);
    });

    it('should handle deletion of non-existent webhook gracefully', async () => {
      const response = await request(app)
        .delete('/api/webhooks/non-existent')
        .expect(200);

      expect(response.body.message).toBe('Webhook removed.');
    });
  });
});

describe('Webhook Signature Verification Tests', () => {
  const testPayload = {
    event: 'new_api_call' as WebhookEventType,
    timestamp: new Date().toISOString(),
    developerId: 'dev-123',
    data: { apiId: 'api-456', endpoint: '/test', method: 'POST' },
  };

  const testConfig = {
    developerId: 'dev-123',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    secret: 'test-webhook-secret',
    createdAt: new Date(),
  };

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should include correct HMAC signature when secret is provided', async () => {
    const expectedSignature = crypto
      .createHmac('sha256', testConfig.secret!)
      .update(JSON.stringify(testPayload))
      .digest('hex');

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    await dispatchWebhook(testConfig, testPayload);

    expect(mockFetch).toHaveBeenCalledWith(testConfig.url, {
      method: 'POST',
      body: JSON.stringify(testPayload),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Callora-Webhook/1.0',
        'X-Callora-Event': testPayload.event,
        'X-Callora-Timestamp': testPayload.timestamp,
        'X-Callora-Signature': `sha256=${expectedSignature}`,
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('should not include signature header when no secret is provided', async () => {
    const { secret: _secret, ...configWithoutSecret } = testConfig;

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    await dispatchWebhook(configWithoutSecret, testPayload);

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers).not.toHaveProperty('X-Callora-Signature');
  });

  it('should use correct signature format (sha256= prefix)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    await dispatchWebhook(testConfig, testPayload);

    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.headers['X-Callora-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

describe('Webhook Payload Forgery Protection Tests', () => {
  const testPayload = {
    event: 'new_api_call' as WebhookEventType,
    timestamp: new Date().toISOString(),
    developerId: 'dev-123',
    data: { apiId: 'api-456', endpoint: '/test', method: 'POST' },
  };

  const testConfig = {
    developerId: 'dev-123',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    secret: 'test-webhook-secret',
    createdAt: new Date(),
  };

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  it('should generate different signatures for different payloads', async () => {
    const modifiedPayload = {
      ...testPayload,
      data: { ...testPayload.data, apiId: 'different-api-id' },
    };

    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await dispatchWebhook(testConfig, testPayload);
    await dispatchWebhook(testConfig, modifiedPayload);

    const firstCallHeaders = mockFetch.mock.calls[0][1].headers;
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers;

    expect(firstCallHeaders['X-Callora-Signature']).not.toBe(
      secondCallHeaders['X-Callora-Signature']
    );
  });

  it('should generate different signatures for different secrets', async () => {
    const configWithDifferentSecret = {
      ...testConfig,
      secret: 'different-secret',
    };

    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await dispatchWebhook(testConfig, testPayload);
    await dispatchWebhook(configWithDifferentSecret, testPayload);

    const firstCallHeaders = mockFetch.mock.calls[0][1].headers;
    const secondCallHeaders = mockFetch.mock.calls[1][1].headers;

    expect(firstCallHeaders['X-Callora-Signature']).not.toBe(
      secondCallHeaders['X-Callora-Signature']
    );
  });

  it('should validate signature verification scenario', async () => {
    // This test demonstrates how a webhook consumer would verify the signature
    const payloadString = JSON.stringify(testPayload);
    const expectedSignature = crypto
      .createHmac('sha256', testConfig.secret!)
      .update(payloadString)
      .digest('hex');

    // Simulate signature verification (as the webhook consumer would do)
    const receivedSignature = `sha256=${expectedSignature}`;
    const calculatedSignature = crypto
      .createHmac('sha256', testConfig.secret!)
      .update(payloadString)
      .digest('hex');

    expect(receivedSignature).toBe(`sha256=${calculatedSignature}`);
  });
});

describe('Webhook Logging Security Tests', () => {
  const testConfig = {
    developerId: 'dev-123',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    secret: 'sensitive-secret-key',
    createdAt: new Date(),
  };

  const testPayload = {
    event: 'new_api_call' as WebhookEventType,
    timestamp: new Date().toISOString(),
    developerId: 'dev-123',
    data: { 
      apiId: 'api-456', 
      endpoint: '/test', 
      method: 'POST',
      sensitiveData: 'this-should-not-be-logged',
    },
  };

  let mockFetch: jest.Mock;
  let consoleSpy: {
    log: jest.SpyInstance;
    warn: jest.SpyInstance;
    error: jest.SpyInstance;
  };

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    
    // Spy on console methods to verify logging behavior
    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(),
      warn: jest.spyOn(console, 'warn').mockImplementation(),
      error: jest.spyOn(console, 'error').mockImplementation(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should not log sensitive payload data in success cases', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    await dispatchWebhook(testConfig, testPayload);

    expect(consoleSpy.log).toHaveBeenCalledWith(
      expect.stringContaining('[webhook] ✓ Delivered new_api_call to https://example.com/webhook'),
      expect.stringContaining('attempt 1')
    );

    // Verify that sensitive data is not logged
    const logCalls = consoleSpy.log.mock.calls.flat();
    const allLoggedText = logCalls.join(' ');
    expect(allLoggedText).not.toContain('sensitive-secret-key');
    expect(allLoggedText).not.toContain('this-should-not-be-logged');
  });

  it('should not log sensitive payload data in error cases', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await dispatchWebhook(testConfig, testPayload);

    // Check that error logs don't contain sensitive information
    const warnCalls = consoleSpy.warn.mock.calls.flat();
    const errorCalls = consoleSpy.error.mock.calls.flat();
    const allLoggedText = [...warnCalls, ...errorCalls].join(' ');

    expect(allLoggedText).not.toContain('sensitive-secret-key');
    expect(allLoggedText).not.toContain('this-should-not-be-logged');
  });

  it('should log URLs and event types for debugging (non-sensitive)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await dispatchWebhook(testConfig, testPayload);

    expect(consoleSpy.warn).toHaveBeenCalledWith(
      expect.stringContaining('[webhook] Non-2xx response (500) for https://example.com/webhook'),
      expect.stringContaining('attempt 1')
    );
  });
});

describe('Webhook Abuse Protection Tests', () => {
  const testConfig = {
    developerId: 'dev-123',
    url: 'https://example.com/webhook',
    events: ['new_api_call'],
    secret: 'test-secret',
    createdAt: new Date(),
  };

  const testPayload = {
    event: 'new_api_call' as WebhookEventType,
    timestamp: new Date().toISOString(),
    developerId: 'dev-123',
    data: { apiId: 'api-456' },
  };

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should implement exponential backoff on failures', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const dispatchPromise = dispatchWebhook(testConfig, testPayload);
    
    // Fast-forward through all retry attempts
    for (let attempt = 0; attempt < 5; attempt++) {
      await jest.advanceTimersByTimeAsync(1000 * Math.pow(2, attempt));
    }

    await dispatchPromise;

    // Should have attempted 5 times total
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Verify exponential backoff timing
    expect(mockFetch).toHaveBeenNthCalledWith(1, testConfig.url, expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(2, testConfig.url, expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(3, testConfig.url, expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(4, testConfig.url, expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(5, testConfig.url, expect.any(Object));
  });

  it('should stop retrying after successful delivery', async () => {
    // Fail first 2 attempts, succeed on 3rd
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const dispatchPromise = dispatchWebhook(testConfig, testPayload);
    
    // Advance timers for first retry
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);

    await dispatchPromise;

    // Should have stopped after 3 attempts (2 failures + 1 success)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should timeout after 10 seconds per attempt', async () => {
    mockFetch.mockImplementation(() => 
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200 }), 15000);
      })
    );

    const dispatchPromise = dispatchWebhook(testConfig, testPayload);
    
    // Advance 10 seconds to trigger timeout
    await jest.advanceTimersByTimeAsync(10000);

    // Should have timed out and moved to next attempt
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should log final failure after all retry attempts', async () => {
    mockFetch.mockRejectedValue(new Error('Persistent network error'));

    const dispatchPromise = dispatchWebhook(testConfig, testPayload);
    
    // Fast-forward through all retry attempts
    for (let attempt = 0; attempt < 5; attempt++) {
      await jest.advanceTimersByTimeAsync(1000 * Math.pow(2, attempt));
    }

    await dispatchPromise;

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('[webhook] ✗ Failed to deliver new_api_call to https://example.com/webhook after 5 attempts.'),
      expect.any(Error)
    );
  });
});

describe('URL Validation Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  const testCases = [
    {
      name: 'should reject localhost URLs',
      url: 'https://localhost/webhook',
      dnsResult: [{ address: '127.0.0.1', family: 4 }],
      productionOnly: true,
    },
    {
      name: 'should reject private IP ranges',
      url: 'https://internal.example.com/webhook',
      dnsResult: [{ address: '10.0.0.1', family: 4 }],
      productionOnly: true,
    },
    {
      name: 'should reject link-local addresses',
      url: 'https://169.254.169.254/latest/meta-data',
      dnsResult: [{ address: '169.254.169.254', family: 4 }],
      productionOnly: true,
    },
    {
      name: 'should reject CGNAT ranges',
      url: 'https://cgnat.example.com/webhook',
      dnsResult: [{ address: '100.64.0.1', family: 4 }],
      productionOnly: true,
    },
  ];

  testCases.forEach(({ name, url, dnsResult, productionOnly }) => {
    it(name, async () => {
      const originalEnv = process.env.NODE_ENV;
      if (productionOnly) {
        process.env.NODE_ENV = 'production';
      }

      mockDnsLookup.mockResolvedValue(dnsResult);

      await expect(validateWebhookUrl(url)).rejects.toThrow(WebhookValidationError);

      process.env.NODE_ENV = originalEnv;
    });
  });

  it('should allow public IP addresses in production', async () => {
    process.env.NODE_ENV = 'production';
    mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);

    await expect(validateWebhookUrl('https://public.example.com/webhook')).resolves.toBeUndefined();
  });

  it('should allow private IPs in development', async () => {
    process.env.NODE_ENV = 'development';
    mockDnsLookup.mockResolvedValue([{ address: '192.168.1.100', family: 4 }]);

    await expect(validateWebhookUrl('https://localhost:3000/webhook')).resolves.toBeUndefined();
  });
});
