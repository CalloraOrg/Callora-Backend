describe('config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load config with defaults when required vars are set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';

    let cfg:
      | {
          config: {
            port: unknown;
            databaseUrl: string;
            restRateLimit: { windowMs: number; maxRequests: number };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.port).toBeDefined();
    expect(cfg!.config.databaseUrl).toContain('postgresql://');
    expect(cfg!.config.restRateLimit.windowMs).toBe(60_000);
    expect(cfg!.config.restRateLimit.maxRequests).toBe(100);
  });

  it('should expose billing concurrency values from environment variables', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.BILLING_MAX_CONCURRENCY_PER_DEV = '3';
    process.env.BILLING_SEMAPHORE_TTL_MS = '15000';

    let cfg: { config: { billingConcurrency: { maxPerDeveloper: number; semaphoreTtlMs: number } } } | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.billingConcurrency.maxPerDeveloper).toBe(3);
    expect(cfg!.config.billingConcurrency.semaphoreTtlMs).toBe(15000);
  });

  it('should expose configured REST rate limit values', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.REST_RATE_LIMIT_WINDOW_MS = '30000';
    process.env.REST_RATE_LIMIT_MAX_REQUESTS = '25';

    let cfg:
      | {
          config: {
            restRateLimit: { windowMs: number; maxRequests: number };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.restRateLimit).toEqual({
      windowMs: 30_000,
      maxRequests: 25,
    });
  });

  it('should expose gateway rate limiter defaults matching the current hardcoded behavior', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';

    let cfg:
      | {
          config: {
            rateLimiter: {
              maxRequests: number;
              windowMs: number;
              store: 'memory' | 'postgres';
              postgresTable: string;
              outageMode: 'fail-closed' | 'fallback';
              fallbackMaxRequests: number;
              fallbackWindowMs: number;
              maxFallbackBuckets: number;
            };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.rateLimiter).toEqual({
      maxRequests: 5,
      windowMs: 60_000,
      store: 'memory',
      postgresTable: 'gateway_rate_limit_buckets',
      outageMode: 'fail-closed',
      fallbackMaxRequests: 10,
      fallbackWindowMs: 60_000,
      maxFallbackBuckets: 10_000,
    });
  });

  it('should expose configured postgres-backed gateway rate limiter values', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.RATE_LIMIT_MAX_REQUESTS = '50';
    process.env.RATE_LIMIT_WINDOW_MS = '10000';
    process.env.RATE_LIMIT_STORE = 'postgres';
    process.env.RATE_LIMIT_PG_TABLE = 'custom_rate_limit_buckets';

    let cfg:
      | {
          config: {
            rateLimiter: {
              maxRequests: number;
              windowMs: number;
              store: 'memory' | 'postgres';
              postgresTable: string;
              outageMode: 'fail-closed' | 'fallback';
              fallbackMaxRequests: number;
              fallbackWindowMs: number;
              maxFallbackBuckets: number;
            };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.rateLimiter).toEqual({
      maxRequests: 50,
      windowMs: 10_000,
      store: 'postgres',
      postgresTable: 'custom_rate_limit_buckets',
      outageMode: 'fail-closed',
      fallbackMaxRequests: 10,
      fallbackWindowMs: 60_000,
      maxFallbackBuckets: 10_000,
    });
  });

  it('fails closed at import when required env vars are missing', async () => {
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_API_KEY;
    delete process.env.METRICS_API_KEY;

    // Dynamic import: env.ts parses process.env at module load, so each import must run after the env mutation above.
    const error = await import('./env.js').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ['JWT_SECRET'] }),
        expect.objectContaining({ path: ['ADMIN_API_KEY'] }),
        expect.objectContaining({ path: ['METRICS_API_KEY'] }),
      ]),
    });
  });

  it('rejects a missing or blank production upstream allowlist after a valid import', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.SOROBAN_BILLING_RPC_URL = 'https://soroban.example.com';
    process.env.UPSTREAM_URL = 'https://api.example.com';
    process.env.UPSTREAM_HOST_ALLOWLIST = 'api.example.com';
    // Dynamic import: each module load must observe the env state set in this test.
    await expect(import('./index.js')).resolves.toBeDefined();

    for (const allowlist of [undefined, '', ' \t ']) {
      jest.resetModules();
      if (allowlist === undefined) {
        delete process.env.UPSTREAM_HOST_ALLOWLIST;
      } else {
        process.env.UPSTREAM_HOST_ALLOWLIST = allowlist;
      }
      await expect(import('./index.js')).rejects.toThrow();
    }
  });
});
